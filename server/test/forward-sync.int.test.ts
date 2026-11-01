import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { requireTestDatabaseUrl, requireStandbyDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll } from "./helpers/db.js";
import { seedTree, insertUser } from "./helpers/seed.js";
import { testSyncConfig, expectIdentical, rowCounts, waitFor, makeRng } from "./helpers/sync.js";
import { randomOp, type FuzzCtx } from "./helpers/fuzz.js";
import { SyncAgent } from "../src/sync/agent.js";
import { readLag, enqueueFullResync, fetchUnsent } from "../src/sync/outbox.js";
import { syncSessions } from "../src/sync/sessions.js";

let pi: postgres.Sql;
let standby: postgres.Sql;
let agents: SyncAgent[] = [];

const agent = (overrides = {}, opts = {}) => {
  const a = new SyncAgent(testSyncConfig(overrides), opts);
  agents.push(a);
  return a;
};

const SESSION_DDL = `
  CREATE TABLE IF NOT EXISTS session (
    sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)`;

beforeAll(async () => {
  pi = connect(requireTestDatabaseUrl(), 6);
  standby = connect(requireStandbyDatabaseUrl(), 6);
  await pi.unsafe(SESSION_DDL);
  await standby.unsafe(SESSION_DDL);
});
afterAll(async () => {
  await Promise.all([pi.end(), standby.end()]);
});
beforeEach(async () => {
  await truncateAll(pi);
  await truncateAll(standby);
});
afterEach(async () => {
  await Promise.all(agents.map((a) => a.close()));
  agents = [];
});

describe("forward sync: basics", () => {
  it("propagates inserts, updates and deletes (cascades included)", async () => {
    const a = agent();
    const t = await seedTree(pi, "Ann");
    expect(await a.drain()).toBeGreaterThan(0);
    await expectIdentical(pi, standby, "after insert");

    await pi`UPDATE bills SET description = 'Changed', tip_amount = 777 WHERE id = ${t.billId}`;
    await pi`UPDATE users SET display_name = 'Ann B' WHERE id = ${t.userId}`;
    await a.drain();
    await expectIdentical(pi, standby, "after update");
    const [bill] = await standby`SELECT description, tip_amount FROM bills WHERE id = ${t.billId}`;
    expect(bill).toEqual({ description: "Changed", tip_amount: 777 });

    await pi`DELETE FROM settlements WHERE id = ${t.settlementId}`;
    await pi.begin(async (tx) => {
      await tx`DELETE FROM bills WHERE group_id = ${t.groupId}`;
      await tx`DELETE FROM groups WHERE id = ${t.groupId}`;
    });
    await a.drain();
    await expectIdentical(pi, standby, "after deletes");
    expect((await rowCounts(standby)).bills).toBe(0);

    // The replica must not have produced its own outbox/deletion-log noise.
    expect((await standby`SELECT count(*)::int AS n FROM sync_outbox`)[0].n).toBe(0);
    expect((await standby`SELECT count(*)::int AS n FROM deletion_log`)[0].n).toBe(0);
  });

  it("preserves updated_at and origin exactly (replica does not restamp rows)", async () => {
    const t = await seedTree(pi);
    await agent().drain();
    const [p] = await pi`SELECT updated_at::text AS u, origin FROM bills WHERE id = ${t.billId}`;
    const [s] = await standby`SELECT updated_at::text AS u, origin FROM bills WHERE id = ${t.billId}`;
    expect(s).toEqual(p);
  });

  it("respects FK order even when every transaction is its own batch (batchSize 1)", async () => {
    await seedTree(pi, "A");
    await seedTree(pi, "B");
    const a = agent({ batchSize: 1 });
    expect(await a.shipBatch()).toBe(1);
    await a.drain();
    await expectIdentical(pi, standby);
    expect((await readLag(pi)).pending).toBe(0);
  });

  it("is idempotent: replaying already-delivered events changes nothing", async () => {
    await seedTree(pi);
    const a = agent();
    await a.drain();
    const before = await rowCounts(standby);
    await pi`UPDATE sync_outbox SET sent_at = NULL`;
    expect(await a.drain()).toBeGreaterThan(0);
    await expectIdentical(pi, standby);
    expect(await rowCounts(standby)).toEqual(before);
  });

  it("a lower outbox id that commits later is still delivered (no cursor skipping)", async () => {
    const a = agent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Txn A takes outbox id N but commits last.
    const slow = pi.begin(async (tx) => {
      await tx`INSERT INTO users (email, password_hash, display_name) VALUES ('slow@x.test', 'h', 'Slow')`;
      await gate;
    });
    await new Promise((r) => setTimeout(r, 100));
    try {
      await insertUser(pi, "Fast"); // higher id, commits first
      expect(await a.drain()).toBe(1);
    } finally {
      release();
      await slow;
    }
    expect(await a.drain()).toBe(1);
    await expectIdentical(pi, standby);
  });

  it("never lets a stale event roll back a newer row or resurrect a row deleted on the target", async () => {
    const t = await seedTree(pi);
    const a = agent();
    await a.drain();

    // Target-side edit + deletion newer than anything the source still has queued.
    await pi`UPDATE users SET display_name = 'Old name' WHERE id = ${t.userId}`; // queued, not delivered
    await pi`UPDATE settlements SET note = 'stale edit' WHERE id = ${t.settlementId}`; // queued, not delivered
    await standby`UPDATE users SET display_name = 'Newer on standby' WHERE id = ${t.userId}`;
    await standby`DELETE FROM settlements WHERE id = ${t.settlementId}`; // writes a tombstone newer than the queued edit

    await a.drain();
    const [u] = await standby`SELECT display_name FROM users WHERE id = ${t.userId}`;
    expect(u.display_name).toBe("Newer on standby");
    expect(await standby`SELECT id FROM settlements WHERE id = ${t.settlementId}`).toHaveLength(0);
  });

  it("batches are transaction-closed: a cascade or interleaved transactions are never cut in half", async () => {
    // (1) A cascading delete: whatever order the triggers fired in, one batch carries all of it.
    const t = await seedTree(pi);
    await agent().drain();
    await pi`DELETE FROM bills WHERE id = ${t.billId}`; // bill + item + assignment
    const cascade = await fetchUnsent(pi, 1);
    expect(cascade.map((e) => `${e.tableName}:${e.op}`).sort()).toEqual([
      "bill_items:delete",
      "bills:delete",
      "item_assignments:delete",
    ]);

    // (2) Two interleaved transactions: asking for 1 event returns both, whole.
    await agent().drain();
    const a = await pi.reserve();
    const b = await pi.reserve();
    try {
      await a`BEGIN`;
      await b`BEGIN`;
      await a`INSERT INTO users (email, password_hash, display_name) VALUES ('ia@x.test', 'h', 'IA')`;
      await b`INSERT INTO users (email, password_hash, display_name) VALUES ('ib@x.test', 'h', 'IB')`;
      await a`UPDATE users SET display_name = 'IA2' WHERE email = 'ia@x.test'`;
      await b`UPDATE users SET display_name = 'IB2' WHERE email = 'ib@x.test'`;
      await a`COMMIT`;
      await b`COMMIT`;
    } finally {
      a.release();
      b.release();
    }
    expect(await fetchUnsent(pi, 1)).toHaveLength(4);
    await agent().drain();
    await expectIdentical(pi, standby);
  });

  it("re-applying a committed batch is safe even when transient states would collide (remove + re-add member)", async () => {
    const userId = await insertUser(pi, "Uma");
    const [g] = await pi`INSERT INTO groups (name, created_by, invite_token) VALUES ('G', ${userId}, 'tok-x') RETURNING id`;
    const [m1] = await pi`INSERT INTO group_members (group_id, user_id, display_name) VALUES (${g.id}, ${userId}, 'Uma') RETURNING id`;
    await agent().drain();

    await pi.begin(async (tx) => {
      await tx`DELETE FROM group_members WHERE id = ${m1.id}`;
      await tx`INSERT INTO group_members (group_id, user_id, display_name) VALUES (${g.id}, ${userId}, 'Uma again')`;
    });
    const crashing = agent(
      {},
      {
        hooks: {
          afterCommit: () => {
            throw new Error("crash after commit");
          },
        },
      },
    );
    await expect(crashing.shipBatch()).rejects.toThrow(/after commit/);
    await agent().drain(); // same batch replayed onto a target that already has it
    await expectIdentical(pi, standby);
    expect((await standby`SELECT count(*)::int AS n FROM group_members`)[0].n).toBe(1);
  });

  it("full resync queues every row so an out-of-date replica converges", async () => {
    await seedTree(pi, "A");
    await seedTree(pi, "B");
    await pi`UPDATE sync_outbox SET sent_at = now()`; // pretend history is lost
    expect(await enqueueFullResync(pi)).toBe(16);
    await agent().drain();
    await expectIdentical(pi, standby);
  });
});

describe("forward sync: sessions", () => {
  it("mirrors unexpired sessions, updates changed ones and drops vanished/expired ones", async () => {
    await pi`INSERT INTO session VALUES ('s1', '{"userId":1}', now() + interval '1 day'),
                                          ('s2', '{"userId":2}', now() + interval '1 day'),
                                          ('old', '{"userId":3}', now() - interval '1 day')`;
    expect(await syncSessions(pi, standby)).toEqual({ copied: 2, removed: 0 });
    expect(await standby`SELECT sid FROM session ORDER BY sid`).toEqual([{ sid: "s1" }, { sid: "s2" }]);

    await pi`UPDATE session SET sess = '{"userId":1,"cart":true}' WHERE sid = 's1'`;
    await pi`DELETE FROM session WHERE sid = 's2'`;
    expect(await syncSessions(pi, standby)).toEqual({ copied: 1, removed: 1 });
    expect(await syncSessions(pi, standby)).toEqual({ copied: 0, removed: 0 }); // quiescent
    const [s1] = await standby`SELECT sess FROM session WHERE sid = 's1'`;
    expect(s1.sess).toEqual({ userId: 1, cart: true });
  });
});

describe("forward sync: crash safety", () => {
  it("killed mid-batch (before the target COMMIT): nothing lands, nothing is lost or duplicated after restart", async () => {
    await seedTree(pi, "A");
    await seedTree(pi, "B");
    const crashing = agent(
      {},
      {
        hooks: {
          beforeCommit: () => {
            throw new Error("simulated crash before commit");
          },
        },
      },
    );
    await expect(crashing.shipBatch()).rejects.toThrow(/simulated crash/);
    expect((await rowCounts(standby)).users).toBe(0); // transaction rolled back
    expect((await readLag(pi)).pending).toBeGreaterThan(0); // still queued

    const restarted = agent();
    await restarted.drain();
    await expectIdentical(pi, standby);
    expect((await readLag(pi)).pending).toBe(0);
  });

  it("killed after the target COMMIT but before marking sent: re-applied harmlessly, no duplicates", async () => {
    await seedTree(pi, "A");
    const crashing = agent(
      {},
      {
        hooks: {
          afterCommit: () => {
            throw new Error("simulated crash after commit");
          },
        },
      },
    );
    await expect(crashing.shipBatch()).rejects.toThrow(/after commit/);
    expect((await rowCounts(standby)).bills).toBe(1); // landed
    expect((await readLag(pi)).pending).toBeGreaterThan(0); // but not marked

    await agent().drain();
    await expectIdentical(pi, standby);
    expect(await rowCounts(standby)).toEqual(await rowCounts(pi));
  });

  it("a real agent process SIGKILLed mid-stream and restarted converges with no loss/duplicates", async () => {
    const entry = fileURLToPath(new URL("../src/sync/agent.ts", import.meta.url));
    const serverDir = fileURLToPath(new URL("..", import.meta.url));
    const env = {
      ...process.env,
      SYNC_SOURCE_DATABASE_URL: requireTestDatabaseUrl(),
      SYNC_SOURCE_SSL: "off",
      SYNC_TARGET_DATABASE_URL: requireStandbyDatabaseUrl(),
      SYNC_TARGET_SSL: "off",
      SYNC_BATCH_SIZE: "15",
      SYNC_POLL_MS: "30",
      SYNC_SESSION_SYNC_MS: "0",
      DOTENV_CONFIG_PATH: "/nonexistent/.env.never",
    };
    const children: ChildProcess[] = [];
    const launch = async () => {
      // One process (node --import tsx), not the `tsx` wrapper: SIGKILL must hit the agent itself.
      const child = spawn(process.execPath, ["--import", "tsx", entry], { env, cwd: serverDir, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("agent did not start")), 30_000);
        child.stdout!.on("data", (d: Buffer) => {
          if (d.toString().includes("sync_agent_started")) {
            clearTimeout(t);
            resolve();
          }
        });
        child.once("exit", (code) => reject(new Error(`agent exited early (${code})`)));
      });
      return child;
    };

    try {
      const ctx: FuzzCtx = { sql: pi, rng: makeRng(4242), counter: { n: 0 }, tag: "k" };
      const first = await launch();
      for (let i = 0; i < 150; i++) await randomOp(ctx);
      first.kill("SIGKILL"); // hard kill, possibly mid-transaction
      await new Promise((r) => first.once("exit", r));
      for (let i = 0; i < 150; i++) await randomOp(ctx); // writes while the agent is dead
      expect((await readLag(pi)).pending).toBeGreaterThan(0);

      const second = await launch();
      await waitFor(async () => (await readLag(pi)).pending === 0, 40_000);
      second.kill("SIGTERM");
      const code = await new Promise((r) => second.once("exit", r));
      expect(code).toBe(0); // graceful shutdown
      await expectIdentical(pi, standby, "after kill -9 + restart");
    } finally {
      for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    }
  });
});

describe("forward sync: outage and fuzz", () => {
  it("standby/agent down for a while, writes pile up (lag grows), agent returns and catches up", async () => {
    const ctx: FuzzCtx = { sql: pi, rng: makeRng(7), counter: { n: 0 }, tag: "o" };
    for (let i = 0; i < 200; i++) await randomOp(ctx);
    await new Promise((r) => setTimeout(r, 1200));
    const behind = await readLag(pi);
    expect(behind.pending).toBeGreaterThan(100);
    expect(behind.lagSeconds).toBeGreaterThanOrEqual(1);

    // Agent comes up pointing at a dead target first: fails, backs off, loses nothing.
    const broken = agent({ targetUrl: "postgres://postgres@127.0.0.1:1/nope" });
    await expect(broken.shipBatch()).rejects.toThrow();
    expect((await readLag(pi)).pending).toBe(behind.pending);

    const live = agent();
    const running = live.start();
    await waitFor(async () => (await readLag(pi)).pending === 0);
    const status = await live.status();
    expect(status.lagSeconds).toBe(0);
    expect(status.lastSyncAt).not.toBeNull();
    await live.stop();
    await running;
    await expectIdentical(pi, standby);
  });

  it("1,000 random operations (with crashes injected) end row-for-row identical", async () => {
    const seed = Number(process.env.FUZZ_SEED ?? 20261101);
    const rng = makeRng(seed);
    const ctx: FuzzCtx = { sql: pi, rng, counter: { n: 0 }, tag: "f" };
    let crashMode: "none" | "before" | "after" = "none";
    const a = agent(
      { batchSize: 40 },
      {
        hooks: {
          beforeCommit: () => {
            if (crashMode === "before") throw new Error("fuzz crash before commit");
          },
          afterCommit: () => {
            if (crashMode === "after") throw new Error("fuzz crash after commit");
          },
        },
      },
    );

    let applied = 0;
    let crashes = 0;
    for (let i = 0; i < 1000; i++) {
      if (await randomOp(ctx)) applied++;
      if (rng.chance(0.08)) {
        crashMode = rng.chance(0.25) ? "before" : rng.chance(0.33) ? "after" : "none";
        try {
          await a.shipBatch();
        } catch {
          crashes++;
        }
        crashMode = "none";
      }
    }
    await a.drain();

    expect(applied, `seed ${seed}`).toBeGreaterThan(700);
    expect(crashes).toBeGreaterThan(0);
    await expectIdentical(pi, standby, `seed ${seed}`);
    const counts = await rowCounts(pi);
    expect(counts.bills).toBeGreaterThan(20);
    expect((await readLag(pi)).pending).toBe(0);
  });
});
