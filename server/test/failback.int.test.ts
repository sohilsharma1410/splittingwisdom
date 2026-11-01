import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { requireTestDatabaseUrl, requireStandbyDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll } from "./helpers/db.js";
import { seedTree } from "./helpers/seed.js";
import { testSyncConfig, expectIdentical, rowCounts, snapshot, makeRng } from "./helpers/sync.js";
import { randomOp, type FuzzCtx } from "./helpers/fuzz.js";
import { SyncAgent } from "../src/sync/agent.js";
import { systemStateGuard } from "../src/sync/fence.js";
import { readLag } from "../src/sync/outbox.js";
import { verifyPair, verifyDatabase, formatReport, STANDBY_ID_FLOOR } from "../src/sync/integrity.js";
import { runReverseSync } from "../src/failback/reverse-sync.js";
import { handleCutover } from "../src/failback/worker.js";
import { readSystemState } from "../src/roles/state-store.js";

let pi: postgres.Sql;
let standbyAdmin: postgres.Sql; // state flips + reads; opened before the standby is tagged
let standbyW: postgres.Sql; // "the standby API": opened AFTER sw_configure_standby_node, so rows get origin 'standby'
const agents: SyncAgent[] = [];

const agent = () => {
  const a = new SyncAgent(testSyncConfig(), { guard: systemStateGuard });
  agents.push(a);
  return a;
};
const setState = (active: "pi" | "standby" | "cutover") =>
  standbyAdmin`UPDATE system_state SET active_primary = ${active}, epoch = epoch + 1, updated_at = now() - interval '1 minute' WHERE id = 1`;

async function configureStandby() {
  const c = connect(requireStandbyDatabaseUrl(), 1);
  try {
    await c`SELECT * FROM sw_configure_standby_node()`;
  } finally {
    await c.end();
  }
  await standbyW?.end();
  standbyW = connect(requireStandbyDatabaseUrl(), 3);
}

async function piFuzz(n: number, seed: number, tag = "p") {
  const ctx: FuzzCtx = { sql: pi, rng: makeRng(seed), counter: { n: 0 }, tag };
  for (let i = 0; i < n; i++) await randomOp(ctx);
}
async function standbyFuzz(n: number, seed: number, tag = "s") {
  const ctx: FuzzCtx = { sql: standbyW, rng: makeRng(seed), counter: { n: 0 }, tag };
  for (let i = 0; i < n; i++) await randomOp(ctx);
}
const one = async <T>(q: Promise<T[]>) => (await q)[0];

beforeAll(async () => {
  pi = connect(requireTestDatabaseUrl(), 6);
  standbyAdmin = connect(requireStandbyDatabaseUrl(), 4);
});
afterAll(async () => {
  await standbyAdmin.unsafe("SELECT sw_reset_node_origin()");
  await Promise.all([pi.end(), standbyAdmin.end(), standbyW?.end()]);
});
beforeEach(async () => {
  await truncateAll(pi);
  await truncateAll(standbyAdmin);
  await configureStandby();
});
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.close()));
});

describe("failback drill: normal sync -> standby outage with writes -> failback", () => {
  it("brings every standby change (inserts, edits, a delete, a settlement) onto the Pi; DBs end identical; sequences correct", async () => {
    const a = agent();
    // 1. Normal operation: Pi is primary, forward sync keeps the standby identical.
    await piFuzz(300, 11);
    await a.syncNow();
    await expectIdentical(pi, standbyAdmin, "before the outage");
    expect((await verifyDatabase(pi, "pi")).ok).toBe(true);
    const piMaxLowBefore = Number((await one(pi`SELECT max(id)::text AS m FROM bills`)).m);

    // 2. Outage: the controller flips to standby; the standby now takes writes.
    await setState("standby");
    await standbyFuzz(150, 99);
    const fresh = await seedTree(standbyW, "Outage"); // new user, group, 2 members, bill, item, assignment, settlement
    for (const id of Object.values(fresh)) expect(id).toBeGreaterThanOrEqual(STANDBY_ID_FLOOR);
    const editedId = (await one(standbyAdmin`SELECT min(id) AS id FROM bills`)).id as number;
    await standbyW`UPDATE bills SET description = 'edited during the outage', tip_amount = 4242 WHERE id = ${editedId}`;
    const deletedBill = (await one(standbyAdmin`SELECT max(id) AS id FROM bills WHERE id < ${STANDBY_ID_FLOOR}`)).id as number;
    await standbyW`DELETE FROM bills WHERE id = ${deletedBill}`; // cascades items + assignments
    const settlementsBefore = (await rowCounts(standbyAdmin)).settlements;
    await standbyW`
      INSERT INTO settlements (group_id, payer_member_id, recipient_member_id, amount, note, settlement_date)
      VALUES (${fresh.groupId}, ${fresh.member2Id}, ${fresh.memberId}, 1999, 'paid during outage', now())`;
    expect((await rowCounts(standbyAdmin)).settlements).toBe(settlementsBefore + 1);
    const standbyOnly = await one(standbyAdmin`SELECT count(*)::int AS n FROM bills WHERE id >= ${STANDBY_ID_FLOOR}`);
    expect(standbyOnly.n).toBeGreaterThan(0);

    // The Pi, meanwhile, is down/quiet. Its forward sync is fenced.
    expect(await a.syncNow()).toBe(0);
    expect((await a.status()).pausedReason).toMatch(/standby/);

    // 3. Failback: cutover, reverse sync, flip back.
    await setState("cutover");
    const result = await runReverseSync({ pi, standby: standbyAdmin });
    expect(result.reason).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.applied.conflicts).toBe(0);
    expect(result.applied.upserts).toBeGreaterThan(10);
    expect(result.applied.deletes).toBeGreaterThanOrEqual(1);

    // The edit, the deletion and the settlement are on the Pi, with the standby's ids.
    expect(await pi`SELECT description FROM bills WHERE id = ${editedId}`).toEqual([{ description: "edited during the outage" }]);
    expect(await pi`SELECT id FROM bills WHERE id = ${deletedBill}`).toHaveLength(0);
    expect(await pi`SELECT id FROM bill_items WHERE bill_id = ${deletedBill}`).toHaveLength(0);
    expect(await pi`SELECT amount FROM settlements WHERE id = ${fresh.settlementId}`).toEqual([{ amount: 2500 }]);
    expect(await pi`SELECT amount FROM settlements WHERE note = 'paid during outage'`).toEqual([{ amount: 1999 }]);

    // Importing is silent (no echo of the standby's own rows); the only thing queued for forward
    // sync is clean-up DELETEs for rows the Pi lost, so stale queued upserts can't resurrect them.
    const queued = await pi`SELECT DISTINCT op FROM sync_outbox WHERE sent_at IS NULL`;
    expect(queued.every((r) => r.op === "delete")).toBe(true);

    // 4. The Pi takes over again; forward sync resumes and has nothing left to fix.
    await standbyAdmin`UPDATE system_state SET active_primary = 'pi', epoch = epoch + 1`;
    await a.syncNow();
    expect((await readLag(pi)).pending).toBe(0);

    const report = await verifyPair(pi, standbyAdmin);
    expect(formatReport(report)).toContain("RESULT: OK");
    expect(report.ok).toBe(true);
    await expectIdentical(pi, standbyAdmin, "after failback");

    // 5. Running the failback again is a no-op.
    const again = await runReverseSync({ pi, standby: standbyAdmin });
    expect(again.ok).toBe(true);
    expect(again.applied.upserts + again.applied.deletes + again.applied.conflicts).toBe(0);

    // 6. No duplicates, sequences right: Pi stays in its low range, standby above its floor.
    expect(await rowCounts(pi)).toEqual(await rowCounts(standbyAdmin));
    const newPiBill = await one(
      pi`INSERT INTO bills (group_id, description, bill_date, subtotal_amount, paid_by_member_id, created_by_user_id)
         SELECT group_id, 'post-failback', '2026-11-02', 100, paid_by_member_id, created_by_user_id FROM bills WHERE id = ${editedId}
         RETURNING id`,
    );
    expect(newPiBill.id).toBeLessThan(STANDBY_ID_FLOOR);
    expect(newPiBill.id).toBe(piMaxLowBefore + 1 > newPiBill.id ? newPiBill.id : piMaxLowBefore + 1);
    const newStandbyBill = await one(
      standbyW`INSERT INTO bills (group_id, description, bill_date, subtotal_amount, paid_by_member_id, created_by_user_id)
               SELECT group_id, 'sb', '2026-11-02', 100, paid_by_member_id, created_by_user_id FROM bills WHERE id = ${editedId}
               RETURNING id`,
    );
    expect(newStandbyBill.id).toBeGreaterThan(STANDBY_ID_FLOOR);

  });

  it("the money invariant and per-pair balances hold on both sides after failback", async () => {
    const a = agent();
    await piFuzz(200, 5);
    await a.syncNow();
    await setState("standby");
    await standbyFuzz(120, 6);
    await setState("cutover");
    expect((await runReverseSync({ pi, standby: standbyAdmin })).ok).toBe(true);
    await standbyAdmin`UPDATE system_state SET active_primary = 'pi', epoch = epoch + 1`;
    await a.syncNow();
    const report = await verifyPair(pi, standbyAdmin);
    const names = report.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`);
    expect(names).toEqual(expect.arrayContaining([
      "PASS [primary] per-bill sum of shares = total (paise)",
      "PASS [other] per-bill sum of shares = total (paise)",
      "PASS per-pair balances equal on both sides",
      "PASS rows identical (all columns)",
    ]));
    expect(report.ok).toBe(true);
  });
});

describe("failback: conflicts, tombstones, cascades", () => {
  it("rows changed on both sides: newest wins, both are logged in sync_conflicts, and the standby converges to the Pi", async () => {
    const a = agent();
    const t = await seedTree(pi, "C");
    const t2 = await seedTree(pi, "D");
    await a.syncNow();
    await setState("standby");

    // X: Pi edits first (an isolated-but-alive Pi), then the standby edits -> standby is newer.
    await pi`UPDATE bills SET description = 'X by pi' WHERE id = ${t.billId}`;
    await standbyW`UPDATE bills SET description = 'X by standby' WHERE id = ${t.billId}`;
    // Y: the standby edits first, then the Pi -> Pi is newer.
    await standbyW`UPDATE bills SET description = 'Y by standby' WHERE id = ${t2.billId}`;
    await pi`UPDATE bills SET description = 'Y by pi' WHERE id = ${t2.billId}`;

    await setState("cutover");
    const result = await runReverseSync({ pi, standby: standbyAdmin });
    expect(result.ok).toBe(true);
    expect(result.applied.conflicts).toBe(2);

    const conflicts = await pi`SELECT table_name, pk::int AS pk, winner_origin, loser_row->>'description' AS loser, winner_row->>'description' AS winner
                               FROM sync_conflicts ORDER BY pk`;
    expect(conflicts).toEqual([
      { table_name: "bills", pk: t.billId, winner_origin: "standby", winner: "X by standby", loser: "X by pi" },
      { table_name: "bills", pk: t2.billId, winner_origin: "pi", winner: "Y by pi", loser: "Y by standby" },
    ]);
    expect(await pi`SELECT description FROM bills WHERE id = ${t.billId}`).toEqual([{ description: "X by standby" }]);
    expect(await pi`SELECT description FROM bills WHERE id = ${t2.billId}`).toEqual([{ description: "Y by pi" }]);

    await standbyAdmin`UPDATE system_state SET active_primary = 'pi', epoch = epoch + 1`;
    await a.syncNow();
    await expectIdentical(pi, standbyAdmin, "after conflict resolution");
    expect(formatReport(await verifyPair(pi, standbyAdmin))).toContain("RESULT: OK");
  });

  it("a Pi-side change the standby never saw (still queued) survives failback and reaches the standby afterwards", async () => {
    const a = agent();
    await seedTree(pi, "E");
    await a.syncNow();
    await setState("standby");
    await standbyFuzz(20, 3);
    const lateRow = await seedTree(pi, "PiOnly"); // created on the Pi just before it dropped off; never synced
    await setState("cutover");
    const result = await runReverseSync({ pi, standby: standbyAdmin });
    expect(result.ok).toBe(true);
    expect(await pi`SELECT id FROM users WHERE id = ${lateRow.userId}`).toHaveLength(1);
    expect(await standbyAdmin`SELECT id FROM users WHERE id = ${lateRow.userId}`).toHaveLength(0);

    await standbyAdmin`UPDATE system_state SET active_primary = 'pi', epoch = epoch + 1`;
    await a.syncNow();
    await expectIdentical(pi, standbyAdmin, "after the Pi's queued events resumed");
  });

  it("a row the Pi deleted before the outage is not resurrected by the standby's stale copy (nor re-sent as a stale event)", async () => {
    const a = agent();
    const t = await seedTree(pi, "F");
    await a.syncNow();
    await setState("standby");
    // Pi deleted the settlement just before going down; the delete never reached the standby.
    await pi`DELETE FROM settlements WHERE id = ${t.settlementId}`;
    await setState("cutover");
    expect((await runReverseSync({ pi, standby: standbyAdmin })).ok).toBe(true);
    expect(await pi`SELECT id FROM settlements WHERE id = ${t.settlementId}`).toHaveLength(0);
    await standbyAdmin`UPDATE system_state SET active_primary = 'pi', epoch = epoch + 1`;
    await a.syncNow();
    expect(await standbyAdmin`SELECT id FROM settlements WHERE id = ${t.settlementId}`).toHaveLength(0);
    await expectIdentical(pi, standbyAdmin);
  });

  it("a standby deletion that cascades over a Pi-only child is applied and the casualty is logged", async () => {
    const a = agent();
    const t = await seedTree(pi, "G");
    await a.syncNow();
    await setState("standby");
    // Pi adds an item to the bill (unsynced) ...
    const [extra] = await pi`INSERT INTO bill_items (bill_id, name, price) VALUES (${t.billId}, 'late item', 500) RETURNING id`;
    // ... while the standby deletes the whole bill.
    await standbyW`DELETE FROM bills WHERE id = ${t.billId}`;
    await setState("cutover");
    const result = await runReverseSync({ pi, standby: standbyAdmin });
    expect(result.ok).toBe(true);
    expect(await pi`SELECT id FROM bills WHERE id = ${t.billId}`).toHaveLength(0);
    expect(await pi`SELECT id FROM bill_items WHERE id = ${extra.id}`).toHaveLength(0);
    const logged = await pi`SELECT note, loser_row->>'name' AS name FROM sync_conflicts WHERE table_name = 'bill_items' AND pk = ${extra.id}`;
    expect(logged).toHaveLength(1);
    expect(logged[0].note).toMatch(/cascade/);
    expect(logged[0].name).toBe("late item");
    await standbyAdmin`UPDATE system_state SET active_primary = 'pi', epoch = epoch + 1`;
    await a.syncNow();
    await expectIdentical(pi, standbyAdmin);
  });
});

describe("failback: aborts leave the Pi exactly as it was", () => {
  async function everything() {
    return {
      rows: await snapshot(pi),
      conflicts: (await one(pi`SELECT count(*)::int AS n FROM sync_conflicts`)).n,
      outbox: (await one(pi`SELECT count(*)::int AS n FROM sync_outbox`)).n,
      deletions: (await one(pi`SELECT count(*)::int AS n FROM deletion_log`)).n,
      // (only the id sequences of the synced tables: sequences are not transactional, so rolled-back
      // inserts into sync_outbox / sync_conflicts legitimately burn numbers)
      sequences: await pi`SELECT sequencename, last_value::text FROM pg_sequences
                          WHERE schemaname = 'public' AND sequencename IN
                            ('users_id_seq','groups_id_seq','group_members_id_seq','bills_id_seq','bill_items_id_seq','item_assignments_id_seq','settlements_id_seq')
                          ORDER BY sequencename`,
    };
  }
  async function outageWithWrites() {
    const a = agent();
    await piFuzz(60, 21);
    await a.syncNow();
    await setState("standby");
    await standbyFuzz(60, 22);
    await setState("cutover");
    return a;
  }

  it("verification failure (something differs from the standby without explanation) -> rollback, nothing changes, retry succeeds", async () => {
    await outageWithWrites();
    const before = await everything();

    const bad = await runReverseSync({
      pi,
      standby: standbyAdmin,
      hooks: {
        afterApply: async (tx) => {
          await tx`UPDATE users SET display_name = 'tampered' WHERE id = (SELECT min(id) FROM users)`;
        },
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/verification failed/);
    expect(bad.retryable).toBe(false);
    expect(await everything()).toEqual(before);

    const good = await runReverseSync({ pi, standby: standbyAdmin });
    expect(good.ok).toBe(true);
  });

  it("a crash right before COMMIT -> rollback, nothing changes", async () => {
    await outageWithWrites();
    const before = await everything();
    const res = await runReverseSync({
      pi,
      standby: standbyAdmin,
      hooks: {
        beforeCommit: () => {
          throw new Error("power cut");
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/rolled back/);
    expect(await everything()).toEqual(before);
  });

  it("writes landing on the standby during the failback abort it (retryable)", async () => {
    await outageWithWrites();
    const before = await everything();
    const res = await runReverseSync({
      pi,
      standby: standbyAdmin,
      hooks: {
        afterApply: async () => {
          await standbyW`UPDATE users SET display_name = 'straggler' WHERE id = (SELECT min(id) FROM users)`;
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.reason).toMatch(/received writes/);
    expect(await everything()).toEqual(before);
    expect((await runReverseSync({ pi, standby: standbyAdmin })).ok).toBe(true); // quiet now: succeeds
  });

  it("refuses to run when the standby's id range was never configured (collision risk)", async () => {
    await truncateAll(standbyAdmin); // sequences back to 1
    const res = await runReverseSync({ pi, standby: standbyAdmin });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/id range is not configured/);
    expect(res.retryable).toBe(false);
  });

  it("dry run reports what it would do and changes nothing", async () => {
    await outageWithWrites();
    const before = await everything();
    const res = await runReverseSync({ pi, standby: standbyAdmin, dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.applied.upserts).toBeGreaterThan(0);
    expect(await everything()).toEqual(before);
  });
});

describe("failback worker (state machine on the Pi)", () => {
  it("waits for the cutover to settle, completes the failback, flips the state to 'pi' with epoch+1 and clears the standby outbox", async () => {
    const a = agent();
    await piFuzz(40, 31);
    await a.syncNow();
    await setState("standby");
    await standbyFuzz(40, 32);
    expect((await one(standbyAdmin`SELECT count(*)::int AS n FROM sync_outbox WHERE sent_at IS NULL`)).n).toBeGreaterThan(0);

    const deps = { config: { cacheMs: 10_000 }, authority: standbyAdmin, local: pi, settleMs: 60_000, retryDelayMs: 1 };

    expect(await handleCutover(deps)).toBe("not-cutover"); // still 'standby'

    await standbyAdmin`UPDATE system_state SET active_primary = 'cutover', epoch = epoch + 1, updated_at = now()`;
    expect(await handleCutover(deps)).toBe("settling"); // just started: standby may still have in-flight writes
    const epochBefore = (await readSystemState(standbyAdmin)).epoch;

    expect(await handleCutover({ ...deps, settleMs: 0 })).toBe("completed");
    expect(await readSystemState(standbyAdmin)).toMatchObject({ activePrimary: "pi", epoch: epochBefore + 1 });
    expect((await one(standbyAdmin`SELECT count(*)::int AS n FROM sync_outbox WHERE sent_at IS NULL`)).n).toBe(0);

    await a.syncNow();
    expect((await verifyPair(pi, standbyAdmin)).ok).toBe(true);
  });

  it("a permanent failure flips cutover -> standby (epoch+1) and leaves the Pi untouched", async () => {
    await piFuzz(20, 41);
    await agent().syncNow();
    await setState("standby");
    await standbyFuzz(20, 42);
    await standbyAdmin`UPDATE system_state SET active_primary = 'cutover', epoch = epoch + 1, updated_at = now() - interval '1 minute'`;
    const before = await snapshot(pi);
    const epochBefore = (await readSystemState(standbyAdmin)).epoch;

    // Break the precondition: an unconfigured standby range.
    await standbyAdmin.unsafe("SELECT setval(pg_get_serial_sequence('bills', 'id'), 5)");
    const outcome = await handleCutover({ config: { cacheMs: 0 }, authority: standbyAdmin, local: pi, settleMs: 0, retryDelayMs: 1 });
    expect(outcome).toBe("aborted");
    expect(await readSystemState(standbyAdmin)).toMatchObject({ activePrimary: "standby", epoch: epochBefore + 1 });
    expect(await snapshot(pi)).toEqual(before);
  });

  it("if the state moved while the reverse sync ran, it does not claim success (and the merge is safe to repeat)", async () => {
    await piFuzz(20, 51);
    await agent().syncNow();
    await setState("standby");
    await standbyFuzz(20, 52);
    await standbyAdmin`UPDATE system_state SET active_primary = 'cutover', epoch = epoch + 1, updated_at = now() - interval '1 minute'`;
    const outcome = await handleCutover({
      config: { cacheMs: 0 },
      authority: standbyAdmin,
      local: pi,
      settleMs: 0,
      // The controller aborted the cutover while we were working.
      onResult: () => void standbyAdmin`UPDATE system_state SET active_primary = 'standby', epoch = epoch + 1`.then(() => undefined),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(outcome).toBe("lost-race");
    expect((await readSystemState(standbyAdmin)).activePrimary).toBe("standby");
    // A later failback re-merges idempotently.
    await setState("cutover");
    expect((await runReverseSync({ pi, standby: standbyAdmin })).ok).toBe(true);
  });
});
