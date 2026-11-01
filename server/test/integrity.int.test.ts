import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { requireTestDatabaseUrl, requireStandbyDatabaseUrl } from "./helpers/env.js";
import { connect, truncateAll } from "./helpers/db.js";
import { seedTree } from "./helpers/seed.js";
import {
  verifyDatabase,
  verifyPair,
  checkForeignKeyOrphans,
  checkSequences,
  checkBillInvariants,
  diffDatabases,
  pairBalances,
  formatReport,
} from "../src/sync/integrity.js";

let pi: postgres.Sql;
let standby: postgres.Sql;
beforeAll(() => {
  pi = connect(requireTestDatabaseUrl());
  standby = connect(requireStandbyDatabaseUrl());
});
afterAll(async () => {
  await Promise.all([pi.end(), standby.end()]);
});
beforeEach(async () => {
  await truncateAll(pi);
  await truncateAll(standby);
});

describe("integrity checks", () => {
  it("a healthy database passes every check", async () => {
    await seedTree(pi);
    const report = await verifyDatabase(pi, "pi");
    expect(report.ok).toBe(true);
    expect(formatReport(report)).toContain("RESULT: OK");
  });

  it("detects foreign-key orphans (e.g. after a trigger-less restore)", async () => {
    const t = await seedTree(pi);
    await pi.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`; // skips FK triggers like pg_restore --disable-triggers
      await tx`DELETE FROM bills WHERE id = ${t.billId}`;
    });
    const check = await checkForeignKeyOrphans(pi);
    expect(check.ok).toBe(false);
    expect(JSON.stringify(check.items)).toContain("bill_items");
  });

  it("detects a sequence that is not above max(id) in the node's range", async () => {
    await seedTree(pi);
    await pi.unsafe("SELECT setval(pg_get_serial_sequence('bills', 'id'), 1, false)"); // next id 1 but bill 1 exists
    const check = await checkSequences(pi, "pi");
    expect(check.ok).toBe(false);
    expect(JSON.stringify(check.items)).toContain("bills");
  });

  it("a Pi sequence that drifted into the standby range, or a standby that was never moved, is flagged", async () => {
    await pi.unsafe("SELECT setval(pg_get_serial_sequence('users', 'id'), 1000000005)");
    expect((await checkSequences(pi, "pi")).ok).toBe(false);
    expect((await checkSequences(standby, "standby")).ok).toBe(false); // fresh standby: sequences still low
  });

  it("detects per-bill share totals that do not add up (custom split not equal to the item price)", async () => {
    const t = await seedTree(pi);
    // Item of 10000 assigned as custom amounts 3000 + 3000: the engine can only hand out 6000.
    await pi`UPDATE item_assignments SET split_type = 'custom', custom_amount = 3000 WHERE id = ${t.assignmentId}`;
    const check = await checkBillInvariants(pi);
    // sum(shares) = 3000 but the assigned item is worth 10000 -> violation.
    expect(check.ok).toBe(false);
    expect(check.items?.[0]).toMatchObject({ billId: t.billId, sharesTotal: 3000, expected: 10000 });
  });

  it("two databases: identical ones compare clean; any difference is pinpointed", async () => {
    const t = await seedTree(pi);
    // Copy by hand (same ids), preserving updated_at/origin via the sync escape hatch.
    await standby.begin(async (tx) => {
      await tx`SELECT set_config('sw.sync_apply', 'on', true)`;
      for (const table of ["users", "groups", "group_members", "bills", "bill_items", "item_assignments", "settlements"]) {
        const rows = await pi.unsafe(`SELECT to_jsonb(t) AS r FROM ${table} t ORDER BY id`);
        for (const { r } of rows) {
          await tx.unsafe(`INSERT INTO ${table} SELECT x.* FROM jsonb_populate_record(NULL::${table}, $1::jsonb) x`, [tx.json(r)]);
        }
      }
    });
    expect(await diffDatabases(pi, standby)).toEqual([]);
    expect([...(await pairBalances(pi))]).toEqual([...(await pairBalances(standby))]);

    await standby`UPDATE settlements SET amount = amount + 1 WHERE id = ${t.settlementId}`;
    const diffs = await diffDatabases(pi, standby);
    expect(diffs).toEqual([{ table: "settlements", id: t.settlementId, kind: "different" }]);

    const report = await verifyPair(pi, standby);
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(["rows identical (all columns)", "per-pair balances equal on both sides"]));
  });
});
