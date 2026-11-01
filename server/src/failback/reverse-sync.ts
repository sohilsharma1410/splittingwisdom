import { SYNCED_TABLES, type SyncedTable } from "@splittingwisdom/shared";
import type { Sql, Queryable } from "../sync/client.js";
import { loadColumns, type ColumnsByTable } from "../sync/apply.js";
import {
  STANDBY_ID_FLOOR,
  checkBillInvariants,
  checkForeignKeyOrphans,
  checkSequences,
  diffBalances,
  nodeOrigin,
  pairBalances,
} from "../sync/integrity.js";
import { emptySnapshot, planMerge, refKey, type Plan, type RowRef, type Snapshot } from "./merge.js";

/**
 * Failback / reverse sync (plan S4.3-S4.5): pull everything the standby wrote
 * while it was the primary into the Pi's database, verify, and only then
 * commit. Runs ON THE PI (next to its Postgres) with a connection to the
 * standby database.
 *
 * Safety properties:
 *   - ONE Pi transaction does everything (locks, apply, verify, queue repair
 *     events). Any failed check throws and rolls back: the Pi is left exactly
 *     as it was ("ABORTS, leaving state unchanged").
 *   - Idempotent: running it again after a success changes nothing.
 *   - The standby is read in one REPEATABLE READ snapshot, and fingerprinted
 *     before and just before COMMIT; if it moved in between (a straggling
 *     write) the run aborts as retryable.
 *   - Refuses to run if the standby's id range was never configured
 *     (sw_configure_standby_node) - otherwise ids could silently collide.
 */

const TS = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const TOMB_TS = `to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

export async function loadSnapshot(db: Queryable): Promise<Snapshot> {
  const snap = emptySnapshot();
  for (const table of SYNCED_TABLES) {
    const rows = await db.unsafe<{ id: number; row: Record<string, unknown>; ts: string; origin: string }[]>(
      `SELECT id, to_jsonb(t) AS row, ${TS} AS ts, origin FROM "${table}" t ORDER BY id`,
    );
    for (const r of rows) {
      snap[table].rows.set(r.id, { id: r.id, ts: r.ts, origin: r.origin, row: r.row, text: JSON.stringify(r.row) });
    }
  }
  const tombs = await db.unsafe<{ table_name: SyncedTable; pk: string; ts: string }[]>(
    `SELECT table_name, pk::text AS pk, ${TOMB_TS} AS ts FROM deletion_log`,
  );
  for (const t of tombs) {
    const map = snap[t.table_name]?.tombstones;
    if (!map) continue;
    const pk = Number(t.pk);
    const prev = map.get(pk);
    if (prev === undefined || t.ts > prev) map.set(pk, t.ts);
  }
  return snap;
}

/** Cheap "has anything been written here?" signature. */
export async function fingerprint(db: Queryable): Promise<string> {
  const parts: string[] = [];
  for (const table of SYNCED_TABLES) {
    const [r] = await db.unsafe<{ n: string; m: string }[]>(
      `SELECT count(*)::text AS n, COALESCE(max(updated_at)::text, '') AS m FROM "${table}"`,
    );
    parts.push(`${table}:${r.n}:${r.m}`);
  }
  const [o] = await db.unsafe<{ v: string }[]>(`SELECT COALESCE(max(id), 0)::text AS v FROM sync_outbox`);
  const [d] = await db.unsafe<{ v: string }[]>(`SELECT COALESCE(max(id), 0)::text AS v FROM deletion_log`);
  return `${parts.join("|")}|outbox:${o.v}|del:${d.v}`;
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

function forceUpsertSql(table: SyncedTable, columns: string[]): string {
  const set = columns
    .filter((c) => c !== "id")
    .map((c) => `${q(c)} = EXCLUDED.${q(c)}`)
    .join(", ");
  return (
    `INSERT INTO ${q(table)} SELECT r.* FROM jsonb_populate_record(NULL::${q(table)}, $1::jsonb) AS r ` +
    `ON CONFLICT (id) DO UPDATE SET ${set}`
  );
}

/** Raises each sequence to just above the largest id in the Pi's OWN range (never lowers one, never enters the standby range). */
export async function bumpSequencesToOwnRange(db: Queryable): Promise<void> {
  for (const table of SYNCED_TABLES) {
    const [seq] = await db.unsafe<{ name: string }[]>(`SELECT pg_get_serial_sequence('public.${q(table)}', 'id') AS name`);
    const [cur] = await db.unsafe<{ next: string }[]>(
      `SELECT (CASE WHEN is_called THEN last_value + 1 ELSE last_value END)::text AS next FROM ${seq.name}`,
    );
    const [max] = await db.unsafe<{ m: string | null }[]>(`SELECT max(id)::text AS m FROM ${q(table)} WHERE id < ${STANDBY_ID_FLOOR}`);
    const wanted = (max.m === null ? 0 : Number(max.m)) + 1;
    if (Number(cur.next) < wanted) await db.unsafe(`SELECT setval('${seq.name}', ${wanted}, false)`);
  }
}

class Abort extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ReverseSyncHooks {
  /** Test seam: inside the Pi transaction, after the merge was applied and before verification. */
  afterApply?: (tx: Queryable) => void | Promise<void>;
  /** Test seam: after all checks passed, just before COMMIT. */
  beforeCommit?: () => void | Promise<void>;
}

export interface ReverseSyncOptions {
  pi: Sql;
  standby: Sql;
  /** Last confirmed forward-sync time (UTC fixed-width). Default: read from the Pi's sync_status. */
  watermark?: string | null;
  /** Plan and verify, then roll back. */
  dryRun?: boolean;
  hooks?: ReverseSyncHooks;
}

export interface ReverseSyncResult {
  ok: boolean;
  /** Present when !ok. */
  reason?: string;
  /** Safe and sensible to try again shortly (standby moved during the run). */
  retryable?: boolean;
  applied: { upserts: number; deletes: number; conflicts: number; converge: number; unsyncedOnPi: number };
  warnings: string[];
}

const NOTHING = { upserts: 0, deletes: 0, conflicts: 0, converge: 0, unsyncedOnPi: 0 };

function groupOf(table: SyncedTable, row: Record<string, unknown>, snaps: Snapshot[]): number | null {
  const find = (t: SyncedTable, id: unknown): Record<string, unknown> | undefined => {
    for (const s of snaps) {
      const r = s[t].rows.get(Number(id));
      if (r) return r.row;
    }
    return undefined;
  };
  switch (table) {
    case "users":
      return null;
    case "groups":
      return Number(row.id);
    case "group_members":
    case "bills":
    case "settlements":
      return Number(row.group_id);
    case "bill_items": {
      const bill = find("bills", row.bill_id);
      return bill ? Number(bill.group_id) : null;
    }
    case "item_assignments": {
      const item = find("bill_items", row.bill_item_id);
      const bill = item ? find("bills", item.bill_id) : undefined;
      return bill ? Number(bill.group_id) : null;
    }
  }
}

export async function runReverseSync(opts: ReverseSyncOptions): Promise<ReverseSyncResult> {
  const { pi, standby, hooks } = opts;
  try {
    // 0. Preconditions on the standby.
    const range = await checkSequences(standby, "standby");
    if (!range.ok) {
      throw new Abort(
        `the standby's id range is not configured (run SELECT sw_configure_standby_node() on it): ${JSON.stringify(range.items?.slice(0, 2))}`,
        false,
      );
    }
    const standbyNode = await nodeOrigin(standby);
    const warnings: string[] = standbyNode === "standby" ? [] : ["standby database is not tagged origin 'standby'"];

    // 1. Consistent read of the standby, plus its fingerprint.
    const { standbySnap, fpBefore } = await standby.begin("isolation level repeatable read read only", async (tx) => ({
      standbySnap: await loadSnapshot(tx),
      fpBefore: await fingerprint(tx),
    }));

    // 2. Everything that changes the Pi happens in one transaction.
    const result = await pi.begin(async (tx) => {
      await tx`SELECT set_config('sw.sync_apply', 'on', true)`;
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      // Quiesce writers on the Pi for the duration (it is fenced anyway; belt and braces).
      await tx.unsafe(`LOCK TABLE ${SYNCED_TABLES.map(q).join(", ")} IN SHARE ROW EXCLUSIVE MODE`);

      const piBefore = await loadSnapshot(tx);
      let watermark = opts.watermark;
      if (watermark === undefined) {
        const [w] = await tx<{ ts: string | null }[]>`
          SELECT to_char(last_success_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS ts FROM sync_status WHERE id = 1`;
        watermark = w?.ts ?? null;
      }

      const plan = planMerge({ pi: piBefore, standby: standbySnap, watermark });
      warnings.push(...plan.warnings);

      const columns: ColumnsByTable = await loadColumns(tx);
      await applyPlan(tx, plan, standbySnap, columns);

      // Rows that vanished from the Pi only because a planned delete cascaded over them.
      const piAfterApply = await loadSnapshot(tx);
      const deleted = new Set(plan.deletes.map(refKey));
      for (const table of SYNCED_TABLES) {
        for (const [id, info] of piBefore[table].rows) {
          if (piAfterApply[table].rows.has(id) || deleted.has(refKey({ table, id }))) continue;
          plan.conflicts.push({
            table,
            id,
            winner: "standby",
            winnerTs: null,
            loserTs: info.ts,
            note: "removed by the cascade of a deletion made on the standby",
          });
          plan.converge.push({ table, id, op: "delete" });
        }
      }
      // Importing runs silently (no outbox rows), but the Pi may still hold QUEUED upserts for rows it
      // just lost. Left alone they would later be sent to the standby (which has no tombstone for
      // cascade casualties) and fail on a missing parent, forever. A delete queued after them wins.
      for (const d of plan.deletes) {
        if (!plan.converge.some((c) => c.table === d.table && c.id === d.id && c.op === "delete")) {
          plan.converge.push({ table: d.table, id: d.id, op: "delete" });
        }
      }
      await recordConflicts(tx, plan, piBefore, standbySnap);

      await bumpSequencesToOwnRange(tx);
      await hooks?.afterApply?.(tx);

      // 3. Verify (S4.4). Any failure throws -> ROLLBACK -> Pi unchanged.
      const piAfter = await loadSnapshot(tx);
      const unexplained: string[] = [];
      const differing: RowRef[] = [];
      for (const table of SYNCED_TABLES) {
        const ids = new Set([...piAfter[table].rows.keys(), ...standbySnap[table].rows.keys()]);
        for (const id of ids) {
          const a = piAfter[table].rows.get(id);
          const b = standbySnap[table].rows.get(id);
          if (a && b && a.text === b.text) continue;
          differing.push({ table, id });
          if (!plan.allowedDifferences.has(refKey({ table, id }))) unexplained.push(refKey({ table, id }));
        }
      }
      if (unexplained.length) {
        throw new Abort(`verification failed: ${unexplained.length} row(s) differ from the standby without explanation (${unexplained.slice(0, 5).join(", ")})`, false);
      }
      const fk = await checkForeignKeyOrphans(tx);
      if (!fk.ok) throw new Abort(`verification failed: ${fk.details}`, false);
      const inv = await checkBillInvariants(tx);
      if (!inv.ok) throw new Abort(`verification failed: ${inv.name}: ${inv.details}`, false);
      const seq = await checkSequences(tx, "pi");
      if (!seq.ok) throw new Abort(`verification failed: ${seq.name}: ${JSON.stringify(seq.items?.slice(0, 2))}`, false);

      const affectedGroups = new Set<number>();
      for (const d of differing) {
        const row = piAfter[d.table].rows.get(d.id)?.row ?? standbySnap[d.table].rows.get(d.id)?.row;
        const g = row ? groupOf(d.table, row, [piAfter, standbySnap]) : null;
        if (g !== null) affectedGroups.add(g);
      }
      const balanceDiffs = diffBalances(await pairBalances(tx), await pairBalances(standby), affectedGroups);
      if (balanceDiffs.length) {
        throw new Abort(`verification failed: per-pair balances differ in ${balanceDiffs.length} pair(s): ${JSON.stringify(balanceDiffs.slice(0, 3))}`, false);
      }

      // The standby must not have moved while we worked.
      const fpAfter = await fingerprint(standby);
      if (fpAfter !== fpBefore) throw new Abort("the standby received writes during the failback; try again", true);

      if (opts.dryRun) throw new DryRun(plan);

      await enqueueConverge(tx, plan);
      await hooks?.beforeCommit?.();
      return {
        plan,
        unsyncedOnPi: [...plan.allowedDifferences].filter((k) => !plan.converge.some((c) => refKey(c) === k)).length,
      };
    });

    return {
      ok: true,
      applied: {
        upserts: result.plan.upserts.length,
        deletes: result.plan.deletes.length,
        conflicts: result.plan.conflicts.length,
        converge: result.plan.converge.length,
        unsyncedOnPi: result.unsyncedOnPi,
      },
      warnings,
    };
  } catch (err) {
    if (err instanceof DryRun) {
      return {
        ok: true,
        applied: {
          upserts: err.plan.upserts.length,
          deletes: err.plan.deletes.length,
          conflicts: err.plan.conflicts.length,
          converge: err.plan.converge.length,
          unsyncedOnPi: 0,
        },
        warnings: ["dry run: nothing was changed"],
      };
    }
    if (err instanceof Abort) return { ok: false, reason: err.message, retryable: err.retryable, applied: NOTHING, warnings: [] };
    // Anything unexpected (connection lost, constraint violation at COMMIT...) also rolled back.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `failback failed and was rolled back: ${message.slice(0, 300)}`, retryable: true, applied: NOTHING, warnings: [] };
  }
}

class DryRun extends Error {
  constructor(readonly plan: Plan) {
    super("dry run");
  }
}

const DELETE_ORDER = [...SYNCED_TABLES].reverse();

async function applyPlan(tx: Queryable, plan: Plan, standby: Snapshot, columns: ColumnsByTable): Promise<void> {
  // Deletes children-first, then upserts parents-first. Constraints are deferred anyway.
  for (const table of DELETE_ORDER) {
    for (const d of plan.deletes.filter((x) => x.table === table)) {
      await tx.unsafe(`DELETE FROM ${q(table)} WHERE id = $1::bigint`, [String(d.id)]);
    }
  }
  for (const table of SYNCED_TABLES) {
    const sql = forceUpsertSql(table, columns[table]);
    for (const u of plan.upserts.filter((x) => x.table === table)) {
      const info = standby[table].rows.get(u.id);
      if (!info) throw new Abort(`internal error: planned upsert of ${refKey(u)} has no standby row`, false);
      await tx.unsafe(sql, [(tx as unknown as { json: (v: unknown) => never }).json(info.row)]);
    }
  }
}

async function recordConflicts(tx: Queryable, plan: Plan, pi: Snapshot, standby: Snapshot): Promise<void> {
  for (const c of plan.conflicts) {
    const winnerRow = (c.winner === "pi" ? pi : standby)[c.table].rows.get(c.id)?.row ?? null;
    const loserRow = (c.winner === "pi" ? standby : pi)[c.table].rows.get(c.id)?.row ?? null;
    const json = (tx as unknown as { json: (v: unknown) => never }).json;
    await tx.unsafe(
      `INSERT INTO sync_conflicts (table_name, pk, winner_origin, winner_updated_at, loser_updated_at, winner_row, loser_row, note)
       VALUES ($1, $2::bigint, $3, ($4::timestamp AT TIME ZONE 'UTC'), ($5::timestamp AT TIME ZONE 'UTC'), $6::jsonb, $7::jsonb, $8)`,
      [c.table, String(c.id), c.winner, c.winnerTs, c.loserTs, json(winnerRow), json(loserRow), c.note],
    );
  }
}

/** Queue repair events so the forward sync, once resumed, makes the standby follow the Pi's final state. */
async function enqueueConverge(tx: Queryable, plan: Plan): Promise<void> {
  for (const c of plan.converge) {
    if (c.op === "delete") {
      await tx.unsafe(`INSERT INTO sync_outbox (table_name, pk, op) VALUES ($1, $2::bigint, 'delete')`, [c.table, String(c.id)]);
    } else {
      await tx.unsafe(
        `INSERT INTO sync_outbox (table_name, pk, op, payload)
         SELECT $1, t.id, 'upsert', to_jsonb(t) FROM ${q(c.table)} t WHERE t.id = $2::bigint`,
        [c.table, String(c.id)],
      );
    }
  }
}
