import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireTestDatabaseUrl, requireStandbyDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll, resetAndMigrate, MIGRATIONS_FOLDER, APP_TABLES } from "./helpers/db.js";
import { seedTree, insertUser } from "./helpers/seed.js";
import { getApp, registerUser, createGroup, billBody } from "./helpers/app.js";

let sql: postgres.Sql;

beforeAll(() => {
  sql = connect(requireTestDatabaseUrl());
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await truncateAll(sql);
});

describe("updated_at / origin triggers", () => {
  it("stamps updated_at and origin='pi' on insert for every synced table", async () => {
    const t = await seedTree(sql);
    const ids: Record<string, number> = {
      users: t.userId,
      groups: t.groupId,
      group_members: t.memberId,
      bills: t.billId,
      bill_items: t.itemId,
      item_assignments: t.assignmentId,
      settlements: t.settlementId,
    };
    for (const table of APP_TABLES) {
      const [row] = await sql.unsafe(
        `SELECT origin, extract(epoch FROM (now() - updated_at)) AS age FROM ${table} WHERE id = ${ids[table]}`,
      );
      expect(row.origin, table).toBe("pi");
      expect(Number(row.age), table).toBeLessThan(30);
    }
  });

  it("an UPDATE bumps updated_at strictly forward", async () => {
    const userId = await insertUser(sql);
    const [before] = await sql`SELECT updated_at FROM users WHERE id = ${userId}`;
    await sql`UPDATE users SET display_name = 'Renamed' WHERE id = ${userId}`;
    const [after] = await sql`SELECT updated_at FROM users WHERE id = ${userId}`;
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it("ignores an application-supplied updated_at (DB clock is authoritative)", async () => {
    const t = await seedTree(sql);
    await sql`UPDATE bills SET updated_at = '2001-01-01T00:00:00Z' WHERE id = ${t.billId}`;
    const [row] = await sql`SELECT updated_at FROM bills WHERE id = ${t.billId}`;
    expect(row.updated_at.getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("tags rows 'standby' when the connection's sw.origin is standby", async () => {
    const t = await sql.begin(async (tx) => {
      await tx`SELECT set_config('sw.origin', 'standby', true)`;
      const tree = await seedTree(tx, "S");
      await tx`DELETE FROM settlements WHERE id = ${tree.settlementId}`;
      return tree;
    });
    const [g] = await sql`SELECT origin FROM groups WHERE id = ${t.groupId}`;
    expect(g.origin).toBe("standby");
    const [log] = await sql`SELECT origin FROM deletion_log WHERE table_name = 'settlements'`;
    expect(log.origin).toBe("standby");
  });

  it("with sw.sync_apply on, incoming updated_at/origin are preserved and no deletion is logged", async () => {
    const stamp = "2025-06-01T10:00:00.123456Z";
    const id = await sql.begin(async (tx) => {
      await tx`SELECT set_config('sw.sync_apply', 'on', true)`;
      const [u] = await tx<{ id: number }[]>`
        INSERT INTO users (id, email, password_hash, display_name, updated_at, origin)
        VALUES (900, 'sync@example.test', 'x', 'Synced', ${stamp}, 'standby') RETURNING id`;
      return u.id;
    });
    const [row] = await sql`SELECT updated_at, origin FROM users WHERE id = ${id}`;
    expect(row.updated_at.toISOString()).toBe("2025-06-01T10:00:00.123Z");
    expect(row.origin).toBe("standby");

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('sw.sync_apply', 'on', true)`;
      await tx`UPDATE users SET display_name = 'Synced2', updated_at = ${stamp} WHERE id = ${id}`;
      await tx`DELETE FROM users WHERE id = ${id}`;
    });
    const log = await sql`SELECT * FROM deletion_log`;
    expect(log).toHaveLength(0);
  });
});

describe("deletion_log", () => {
  it("records an ordinary delete with table, pk and origin", async () => {
    const t = await seedTree(sql);
    await sql`DELETE FROM settlements WHERE id = ${t.settlementId}`;
    const rows = await sql`SELECT table_name, pk::int AS pk, origin FROM deletion_log`;
    expect(rows).toEqual([{ table_name: "settlements", pk: t.settlementId, origin: "pi" }]);
  });

  it("records every row removed by a cascading group delete", async () => {
    const t = await seedTree(sql);
    // Cascaded deletes fire the row triggers too. Same order as DELETE /api/groups/:id (bills, settlements, then group).
    await sql.begin(async (tx) => {
      await tx`DELETE FROM bills WHERE group_id = ${t.groupId}`;
      await tx`DELETE FROM settlements WHERE group_id = ${t.groupId}`;
      await tx`DELETE FROM groups WHERE id = ${t.groupId}`;
    });
    const rows = await sql<{ table_name: string; pk: number }[]>`
      SELECT table_name, pk::int AS pk FROM deletion_log ORDER BY table_name, pk`;
    const byTable = (name: string) => rows.filter((r) => r.table_name === name).map((r) => r.pk);
    expect(byTable("groups")).toEqual([t.groupId]);
    expect(byTable("group_members").sort()).toEqual([t.memberId, t.member2Id].sort());
    expect(byTable("bills")).toEqual([t.billId]);
    expect(byTable("bill_items")).toEqual([t.itemId]);
    expect(byTable("item_assignments")).toEqual([t.assignmentId]);
    expect(byTable("settlements")).toEqual([t.settlementId]);
  });
});

describe("API responses do not leak the new columns", () => {
  it("no `origin` anywhere, and no updatedAt on members/users", async () => {
    const app = await getApp();
    const alice = await registerUser(app, "Alice");
    const bob = await registerUser(app, "Bob");
    const { groupId, memberId } = await createGroup(alice);
    const add = await alice.agent.post(`/api/groups/${groupId}/members`).send({ userId: bob.id });
    expect(add.status).toBe(201);
    const bill = await alice.agent
      .post("/api/bills")
      .send(billBody({ groupId, paidByMemberId: memberId, memberIds: [memberId, add.body.data.member.id] }));
    expect(bill.status).toBe(201);

    const responses = [
      add,
      bill,
      await alice.agent.get("/api/auth/me"),
      await alice.agent.get("/api/groups"),
      await alice.agent.get(`/api/groups/${groupId}`),
      await alice.agent.get(`/api/groups/${groupId}/bills`),
      await alice.agent.get(`/api/bills/${bill.body.data.bill.id}`),
      await alice.agent.get("/api/balances"),
    ];
    for (const r of responses) {
      expect(r.status).toBeLessThan(300);
      expect(JSON.stringify(r.body)).not.toMatch(/"origin"/);
    }
    expect(add.body.data.member).not.toHaveProperty("updatedAt");
    expect(Object.keys(add.body.data.member).sort()).toEqual(
      ["displayName", "groupId", "id", "joinedAt", "userId"].sort(),
    );
    // groups/bills always exposed updatedAt; it must still be an ISO instant.
    expect(bill.body.data.bill.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe("sw_configure_standby_node / sw_set_sequence_floor (standby cluster only)", () => {
  let standby: postgres.Sql;
  beforeAll(async () => {
    await resetAndMigrate(requireStandbyDatabaseUrl());
    standby = connect(requireStandbyDatabaseUrl());
  });
  afterAll(async () => {
    await standby.unsafe("SELECT sw_reset_node_origin()");
    await standby.end();
  });

  it("is NOT applied by the default migration: both nodes start in the low range as 'pi'", async () => {
    const id = await insertUser(standby);
    expect(id).toBe(1);
    const [row] = await standby`SELECT origin FROM users WHERE id = 1`;
    expect(row.origin).toBe("pi");
    await truncateAll(standby);
  });

  it("moves every id sequence to 1_000_000_000, idempotently, never downwards, tagging origin", async () => {
    const first = await standby<{ sequence_name: string; next_value: string }[]>`
      SELECT * FROM sw_configure_standby_node()`;
    expect(first).toHaveLength(APP_TABLES.length);
    for (const r of first) expect(Number(r.next_value)).toBe(1_000_000_000);

    // A *new* connection (database-level setting) now stamps rows 'standby'.
    const fresh = connect(requireStandbyDatabaseUrl(), 1);
    try {
      const t = await seedTree(fresh, "Standby");
      expect(t.userId).toBe(1_000_000_000);
      expect(t.billId).toBe(1_000_000_000);
      const [row] = await fresh`SELECT origin FROM bills WHERE id = ${t.billId}`;
      expect(row.origin).toBe("standby");
    } finally {
      await fresh.end();
    }

    // Re-running never lowers a sequence that has moved past the floor.
    const second = await standby<{ sequence_name: string; next_value: string }[]>`
      SELECT * FROM sw_set_sequence_floor(1000000000)`;
    for (const r of second) expect(Number(r.next_value)).toBe(r.sequence_name.includes("group_members") ? 1_000_000_002 : 1_000_000_001);
  });

  it("leaves the primary (pi) cluster in the low id range", async () => {
    const id = await insertUser(sql);
    expect(id).toBe(1);
  });
});

describe("upgrading a populated pre-0005 database", () => {
  it("preserves groups/bills updated_at as the same UTC instant, whatever the session time zone", async () => {
    const url = requireStandbyDatabaseUrl();
    const raw = postgres(url, { max: 1, connection: { TimeZone: "Asia/Kolkata" }, onnotice: () => undefined });
    try {
      await raw.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await raw.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
      const files = readdirSync(MIGRATIONS_FOLDER)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      const apply = async (file: string) => {
        const text = readFileSync(join(MIGRATIONS_FOLDER, file), "utf8");
        for (const stmt of text.split("--> statement-breakpoint")) {
          if (stmt.trim()) await raw.unsafe(stmt);
        }
      };
      for (const f of files.filter((f) => f < "0005")) await apply(f);

      // Old-type data: `timestamp` (no zone) values the app wrote as UTC.
      await raw.unsafe(`
        INSERT INTO users (id, email, password_hash, display_name) VALUES (1, 'a@example.test', 'x', 'A');
        INSERT INTO groups (id, name, created_by, invite_token, updated_at)
          VALUES (1, 'G', 1, 'tok1', '2026-01-01 10:00:00');
        INSERT INTO group_members (id, group_id, user_id, display_name) VALUES (1, 1, 1, 'A');
        INSERT INTO bills (id, group_id, description, bill_date, subtotal_amount, paid_by_member_id, created_by_user_id, updated_at)
          VALUES (1, 1, 'B', '2026-01-02', 100, 1, 1, '2026-01-02 08:30:00');
      `);

      for (const f of files.filter((f) => f >= "0005")) await apply(f);

      const [g] = await raw`SELECT updated_at, origin FROM groups WHERE id = 1`;
      const [b] = await raw`SELECT updated_at, origin FROM bills WHERE id = 1`;
      expect(g.updated_at.toISOString()).toBe("2026-01-01T10:00:00.000Z");
      expect(b.updated_at.toISOString()).toBe("2026-01-02T08:30:00.000Z");
      expect(g.origin).toBe("pi");
      // Rows that had no updated_at get a value (migration time), not NULL.
      const [u] = await raw`SELECT updated_at FROM users WHERE id = 1`;
      expect(u.updated_at).toBeInstanceOf(Date);
    } finally {
      await raw.end();
      await resetAndMigrate(url);
    }
  });
});
