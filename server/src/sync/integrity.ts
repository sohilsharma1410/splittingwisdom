
import {
  SYNCED_TABLES,
  computeBalances,
  computeBillBreakdown,
  billGrandTotal,
  type BillForBalance,
  type SettlementForBalance,
  type SyncedTable,
} from "@splittingwisdom/shared";

/**
 * Data-integrity checks shared by scripts/verify-integrity.ts (QA-4), the
 * reverse-sync verification and the tests. Every function takes anything that
 * can run tagged-template queries: a client or a transaction.
 */
import type { Queryable } from "./client.js";
export type { Queryable };

/** Standby nodes hand out ids from here upwards (migration 0005, sw_configure_standby_node). */
export const STANDBY_ID_FLOOR = 1_000_000_000;

export interface Check {
  name: string;
  ok: boolean;
  details: string;
  /** Machine-readable offenders (capped) */
  items?: unknown[];
}

export interface IntegrityReport {
  ok: boolean;
  checks: Check[];
}

const MAX_ITEMS = 20;

/** Row counts per synced table. */
export async function rowCounts(db: Queryable): Promise<Record<SyncedTable, number>> {
  const out = {} as Record<SyncedTable, number>;
  for (const t of SYNCED_TABLES) {
    const [r] = await db.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`);
    out[t] = r.n;
  }
  return out;
}

/** Orphaned foreign keys across the synced tables (0 expected; FK constraints should make it so, but a trigger-disabled restore can break it). */
export async function checkForeignKeyOrphans(db: Queryable): Promise<Check> {
  const names = SYNCED_TABLES.map((t) => `'${t}'`).join(", ");
  const fks = await db.unsafe<{ child: string; child_col: string; parent: string; parent_col: string }[]>(
    `SELECT cl.relname AS child, ca.attname AS child_col, pl.relname AS parent, pa.attname AS parent_col
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN pg_class pl ON pl.oid = con.confrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
     JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND n.nspname = 'public' AND cl.relname IN (${names})`,
  );
  const orphans: unknown[] = [];
  for (const fk of fks) {
    const rows = await db.unsafe<{ id: number }[]>(
      `SELECT c.id FROM "${fk.child}" c
       WHERE c."${fk.child_col}" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "${fk.parent}" p WHERE p."${fk.parent_col}" = c."${fk.child_col}")
       LIMIT ${MAX_ITEMS}`,
    );
    for (const r of rows) orphans.push({ table: fk.child, id: r.id, references: `${fk.parent}.${fk.parent_col}` });
  }
  return {
    name: "foreign-key orphans",
    ok: orphans.length === 0,
    details: orphans.length === 0 ? `${fks.length} foreign keys, no orphans` : `${orphans.length}+ orphaned rows`,
    items: orphans,
  };
}

interface BalanceData {
  bills: Array<{ id: number; groupId: number; subtotal: number; engine: BillForBalance; allAssigned: boolean; sumPrices: number; assignedPrices: number }>;
  settlements: Array<{ groupId: number; s: SettlementForBalance }>;
}

export async function loadBalanceData(db: Queryable): Promise<BalanceData> {
  const [bills, items, assignments, settlements] = await Promise.all([
    db.unsafe<
      {
        id: number; group_id: number; paid_by_member_id: number; subtotal_amount: number;
        tax_amount: number; tip_amount: number; service_fee_amount: number; discount_amount: number;
      }[]
    >(`SELECT id, group_id, paid_by_member_id, subtotal_amount, tax_amount, tip_amount, service_fee_amount, discount_amount FROM bills ORDER BY id`),
    db.unsafe<{ id: number; bill_id: number; price: number }[]>(`SELECT id, bill_id, price FROM bill_items ORDER BY id`),
    db.unsafe<
      { bill_item_id: number; member_id: number; split_type: "equal" | "percentage" | "ratio" | "custom"; percentage: number | null; ratio: number | null; custom_amount: number | null }[]
    >(`SELECT bill_item_id, member_id, split_type, percentage, ratio, custom_amount FROM item_assignments ORDER BY id`),
    db.unsafe<{ group_id: number; payer_member_id: number; recipient_member_id: number; amount: number }[]>(
      `SELECT group_id, payer_member_id, recipient_member_id, amount FROM settlements ORDER BY id`,
    ),
  ]);

  const assignmentsByItem = new Map<number, (typeof assignments)[number][]>();
  for (const a of assignments) {
    const list = assignmentsByItem.get(a.bill_item_id) ?? [];
    list.push(a);
    assignmentsByItem.set(a.bill_item_id, list);
  }
  const itemsByBill = new Map<number, (typeof items)[number][]>();
  for (const i of items) {
    const list = itemsByBill.get(i.bill_id) ?? [];
    list.push(i);
    itemsByBill.set(i.bill_id, list);
  }

  return {
    bills: bills.map((b) => {
      const its = itemsByBill.get(b.id) ?? [];
      const assigned = its.filter((i) => (assignmentsByItem.get(i.id) ?? []).length > 0);
      return {
        id: b.id,
        groupId: b.group_id,
        subtotal: b.subtotal_amount,
        allAssigned: its.length > 0 && assigned.length === its.length,
        sumPrices: its.reduce((s, i) => s + i.price, 0),
        assignedPrices: assigned.reduce((s, i) => s + i.price, 0),
        engine: {
          paidByMemberId: b.paid_by_member_id,
          taxAmount: b.tax_amount,
          tipAmount: b.tip_amount,
          serviceFeeAmount: b.service_fee_amount,
          discountAmount: b.discount_amount,
          items: its.map((i) => ({
            price: i.price,
            assignments: (assignmentsByItem.get(i.id) ?? []).map((a) => ({
              memberId: a.member_id,
              splitType: a.split_type,
              percentage: a.percentage,
              ratio: a.ratio,
              customAmount: a.custom_amount,
            })),
          })),
        },
      };
    }),
    settlements: settlements.map((s) => ({
      groupId: s.group_id,
      s: { payerMemberId: s.payer_member_id, recipientMemberId: s.recipient_member_id, amount: s.amount },
    })),
  };
}

/**
 * CLAUDE.md money rule: the shares on a bill add up to the bill, to the paisa.
 * Computed with the shared engine (computeBillBreakdown) over the stored items.
 *   - always: sum(member totals) == sum(assigned item prices) + tax + tip + fee - discount
 *   - when every item is assigned and the items add up to the bill's subtotal:
 *     sum(member totals) == billGrandTotal(bill) exactly.
 */
export async function checkBillInvariants(db: Queryable, data?: BalanceData): Promise<Check> {
  const { bills } = data ?? (await loadBalanceData(db));
  const violations: unknown[] = [];
  let strict = 0;
  let skippedUnassigned = 0;
  for (const b of bills) {
    const rows = computeBillBreakdown(b.engine);
    if (rows.length === 0) {
      skippedUnassigned++;
      continue;
    }
    const e = b.engine;
    const sharesTotal = rows.reduce((s, r) => s + r.total, 0);
    const expected = b.assignedPrices + e.taxAmount + e.tipAmount + e.serviceFeeAmount - e.discountAmount;
    if (sharesTotal !== expected) {
      violations.push({ billId: b.id, sharesTotal, expected });
    }
    if (b.allAssigned && b.sumPrices === b.subtotal) {
      strict++;
      const grand = billGrandTotal({
        subtotalAmount: b.subtotal,
        taxAmount: e.taxAmount,
        tipAmount: e.tipAmount,
        serviceFeeAmount: e.serviceFeeAmount,
        discountAmount: e.discountAmount,
      });
      if (sharesTotal !== grand) violations.push({ billId: b.id, sharesTotal, grandTotal: grand, strict: true });
    }
  }
  return {
    name: "per-bill sum of shares = total (paise)",
    ok: violations.length === 0,
    details: `${bills.length} bills (${strict} checked against the exact grand total, ${skippedUnassigned} with no assigned items)${
      violations.length ? `, ${violations.length} violation(s)` : ""
    }`,
    items: violations.slice(0, MAX_ITEMS),
  };
}

/** Net balance per (group, member pair) as computed by the shared engine. Key: `${groupId}:${memberA}:${memberB}` with A < B. */
export async function pairBalances(db: Queryable, data?: BalanceData): Promise<Map<string, number>> {
  const { bills, settlements } = data ?? (await loadBalanceData(db));
  const groups = new Set<number>([...bills.map((b) => b.groupId), ...settlements.map((s) => s.groupId)]);
  const out = new Map<string, number>();
  for (const groupId of [...groups].sort((a, b) => a - b)) {
    const pairs = computeBalances(
      bills.filter((b) => b.groupId === groupId).map((b) => b.engine),
      settlements.filter((s) => s.groupId === groupId).map((s) => s.s),
    );
    for (const p of pairs) out.set(`${groupId}:${p.memberIdA}:${p.memberIdB}`, p.netAmount);
  }
  return out;
}

/** Compares two pair-balance maps (a missing entry counts as 0). Optionally ignoring some groups. */
export function diffBalances(a: Map<string, number>, b: Map<string, number>, ignoreGroups: Set<number> = new Set()): unknown[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const diffs: unknown[] = [];
  for (const k of [...keys].sort()) {
    if (ignoreGroups.has(Number(k.split(":")[0]))) continue;
    const [x, y] = [a.get(k) ?? 0, b.get(k) ?? 0];
    if (x !== y) diffs.push({ pair: k, a: x, b: y });
  }
  return diffs;
}

/**
 * Which node this database is: whether `sw.origin = standby` is set at database
 * level (what sw_configure_standby_node() does). Read from the catalog, not
 * from the session, so a long-lived connection opened before the tag was set
 * still answers correctly.
 */
export async function nodeOrigin(db: Queryable): Promise<"pi" | "standby"> {
  const rows = await db<{ setconfig: string[] }[]>`
    SELECT s.setconfig FROM pg_db_role_setting s
    JOIN pg_database d ON d.oid = s.setdatabase
    WHERE d.datname = current_database() AND s.setrole = 0`;
  return rows.some((r) => r.setconfig.includes("sw.origin=standby")) ? "standby" : "pi";
}

/**
 * Every id sequence must hand out an id above every existing id IN THIS NODE'S
 * RANGE: the Pi's range is ids < 1_000_000_000, the standby's is >= it. (Ids
 * imported from the other range never push a sequence into it, otherwise the
 * Pi's counter would drift into the standby's range after a failback and the
 * next outage could collide.) A standby additionally must be at/above the floor.
 */
export async function checkSequences(db: Queryable, node: "pi" | "standby"): Promise<Check> {
  const problems: unknown[] = [];
  for (const t of SYNCED_TABLES) {
    const [seq] = await db.unsafe<{ name: string | null }[]>(`SELECT pg_get_serial_sequence('public."${t}"', 'id') AS name`);
    if (!seq?.name) {
      problems.push({ table: t, problem: "no id sequence" });
      continue;
    }
    const [s] = await db.unsafe<{ next: string }[]>(
      `SELECT (CASE WHEN is_called THEN last_value + 1 ELSE last_value END)::text AS next FROM ${seq.name}`,
    );
    const next = Number(s.next);
    const range = node === "pi" ? `id < ${STANDBY_ID_FLOOR}` : `id >= ${STANDBY_ID_FLOOR}`;
    const [m] = await db.unsafe<{ max: string | null }[]>(`SELECT max(id)::text AS max FROM "${t}" WHERE ${range}`);
    const max = m.max === null ? 0 : Number(m.max);
    if (next <= max) problems.push({ table: t, next, maxIdInRange: max, problem: "sequence not above max id" });
    if (node === "standby" && next < STANDBY_ID_FLOOR) problems.push({ table: t, next, problem: "standby sequence below its id range floor" });
    if (node === "pi" && next >= STANDBY_ID_FLOOR) problems.push({ table: t, next, problem: "pi sequence has entered the standby id range" });
  }
  return {
    name: `id sequences (${node} range)`,
    ok: problems.length === 0,
    details: problems.length === 0 ? `${SYNCED_TABLES.length} sequences above max id` : `${problems.length} problem(s)`,
    items: problems,
  };
}

/** Full single-database report. */
export async function verifyDatabase(db: Queryable, node?: "pi" | "standby"): Promise<IntegrityReport> {
  const resolvedNode = node ?? (await nodeOrigin(db));
  const counts = await rowCounts(db);
  const data = await loadBalanceData(db);
  const checks: Check[] = [
    { name: "row counts", ok: true, details: SYNCED_TABLES.map((t) => `${t}=${counts[t]}`).join(" ") },
    await checkForeignKeyOrphans(db),
    await checkBillInvariants(db, data),
    await checkSequences(db, resolvedNode),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

export interface RowDifference {
  table: SyncedTable;
  id: number;
  kind: "only-in-a" | "only-in-b" | "different";
}

/** Row-for-row comparison of every synced table (all columns, instants compared in UTC). */
export async function diffDatabases(a: Queryable, b: Queryable, ignoreColumns: string[] = []): Promise<RowDifference[]> {
  const out: RowDifference[] = [];
  for (const table of SYNCED_TABLES) {
    const strip = (r: Record<string, unknown>) => {
      for (const c of ignoreColumns) delete r[c];
      return JSON.stringify(r);
    };
    const load = async (db: Queryable) => {
      const rows = await db.unsafe<{ id: number; row: Record<string, unknown> }[]>(
        `SELECT id, to_jsonb(t) AS row FROM "${table}" t ORDER BY id`,
      );
      return new Map(rows.map((r) => [r.id, strip(r.row)]));
    };
    const [ma, mb] = [await load(a), await load(b)];
    for (const [id, text] of ma) {
      if (!mb.has(id)) out.push({ table, id, kind: "only-in-a" });
      else if (mb.get(id) !== text) out.push({ table, id, kind: "different" });
    }
    for (const id of mb.keys()) if (!ma.has(id)) out.push({ table, id, kind: "only-in-b" });
  }
  return out;
}

/** The full two-database comparison used by the failback drill and scripts/verify-integrity.ts. */
export async function verifyPair(primary: Queryable, other: Queryable, opts: { ignoreColumns?: string[]; otherNode?: "pi" | "standby" } = {}): Promise<IntegrityReport> {
  const [pa, pb] = await Promise.all([verifyDatabase(primary, "pi"), verifyDatabase(other, opts.otherNode)]);
  const [ca, cb] = [await rowCounts(primary), await rowCounts(other)];
  const countDiffs = SYNCED_TABLES.filter((t) => ca[t] !== cb[t]).map((t) => ({ table: t, a: ca[t], b: cb[t] }));
  const rowDiffs = await diffDatabases(primary, other, opts.ignoreColumns);
  const balanceDiffs = diffBalances(await pairBalances(primary), await pairBalances(other));
  const checks: Check[] = [
    ...pa.checks.map((c) => ({ ...c, name: `[primary] ${c.name}` })),
    ...pb.checks.map((c) => ({ ...c, name: `[other] ${c.name}` })),
    {
      name: "row counts equal on both sides",
      ok: countDiffs.length === 0,
      details: countDiffs.length === 0 ? "all tables match" : `${countDiffs.length} table(s) differ`,
      items: countDiffs,
    },
    {
      name: "rows identical (all columns)",
      ok: rowDiffs.length === 0,
      details: rowDiffs.length === 0 ? "no differences" : `${rowDiffs.length} differing row(s)`,
      items: rowDiffs.slice(0, MAX_ITEMS),
    },
    {
      name: "per-pair balances equal on both sides",
      ok: balanceDiffs.length === 0,
      details: balanceDiffs.length === 0 ? "all pairs match" : `${balanceDiffs.length} pair(s) differ`,
      items: balanceDiffs.slice(0, MAX_ITEMS),
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

export function formatReport(report: IntegrityReport): string {
  const lines = report.checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.details}`);
  for (const c of report.checks) {
    if (!c.ok && c.items?.length) lines.push(`      ${c.name}: ${JSON.stringify(c.items.slice(0, 5))}`);
  }
  lines.push(report.ok ? "RESULT: OK" : "RESULT: FAILED");
  return lines.join("\n");
}
