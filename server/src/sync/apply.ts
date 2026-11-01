import { SYNCED_TABLES, type SyncedTable } from "@splittingwisdom/shared";
import type postgres from "postgres";
import type { Sql, Queryable } from "./client.js";

export interface OutboxEvent {
  id: number;
  tableName: SyncedTable;
  pk: number;
  op: "upsert" | "delete";
  payload: Record<string, unknown> | null;
  /** Event time as Postgres text (full microsecond precision). */
  at: string;
}

export type ColumnsByTable = Record<SyncedTable, string[]>;

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

function assertSyncedTable(name: string): asserts name is SyncedTable {
  if (!(SYNCED_TABLES as readonly string[]).includes(name)) {
    throw new Error(`Refusing to sync unknown table "${name}".`);
  }
}

/** Column names of every synced table as they exist on `db` (introspected, not assumed). */
export async function loadColumns(db: Queryable): Promise<ColumnsByTable> {
  const names = SYNCED_TABLES.map((t) => `'${t}'`).join(", "); // constant whitelist, not user input
  const rows = await db.unsafe<{ table_name: string; column_name: string }[]>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN (${names})
     ORDER BY table_name, ordinal_position`,
  );
  const result = Object.fromEntries(SYNCED_TABLES.map((t) => [t, [] as string[]])) as ColumnsByTable;
  for (const r of rows) {
    assertSyncedTable(r.table_name);
    result[r.table_name].push(r.column_name);
  }
  for (const t of SYNCED_TABLES) {
    const cols = result[t];
    if (cols.length === 0) throw new Error(`Table "${t}" is missing on the target — run the migrations there first.`);
    for (const need of ["id", "updated_at", "origin"]) {
      if (!cols.includes(need)) {
        throw new Error(`Table "${t}" on the target has no "${need}" column — migration 0005 not applied.`);
      }
    }
  }
  return result;
}

/**
 * Idempotent upsert of one row image.
 *   - ON CONFLICT (id) DO UPDATE only when the target row is not newer
 *     (last-writer-wins by updated_at), so a re-sent or reordered event can
 *     never roll a row back.
 *   - Skipped entirely if the target holds a deletion tombstone at/after the
 *     image's updated_at, so a stale event cannot resurrect a row that was
 *     deleted on the target side (e.g. during a standby outage).
 */
export function upsertSql(table: SyncedTable, columns: string[]): string {
  const set = columns
    .filter((c) => c !== "id")
    .map((c) => `${q(c)} = EXCLUDED.${q(c)}`)
    .join(", ");
  return (
    `INSERT INTO ${q(table)} ` +
    `SELECT r.* FROM jsonb_populate_record(NULL::${q(table)}, $1::jsonb) AS r ` +
    `WHERE NOT EXISTS (SELECT 1 FROM deletion_log d ` +
    `WHERE d.table_name = '${table}' AND d.pk = r.id AND d.deleted_at >= r.updated_at) ` +
    `ON CONFLICT (id) DO UPDATE SET ${set} WHERE ${q(table)}.updated_at <= EXCLUDED.updated_at`
  );
}

/** Deletes are idempotent; a row edited on the target after the delete happened is left alone. */
export function deleteSql(table: SyncedTable): string {
  return `DELETE FROM ${q(table)} WHERE id = $1::bigint AND updated_at <= $2::timestamptz`;
}

/**
 * Keeps only the LAST event per row (table + pk), in event-id order.
 * Shipping intermediate versions is pointless, and replaying a batch that
 * already committed (crash before the events were marked sent) then only
 * re-applies final states, never transient ones.
 */
export function coalesceEvents(events: OutboxEvent[]): OutboxEvent[] {
  const last = new Map<string, OutboxEvent>();
  for (const e of events) last.set(`${e.tableName}:${e.pk}`, e); // later events overwrite earlier ones
  return [...last.values()].sort((a, b) => a.id - b.id);
}

export interface ApplyHooks {
  /** Test seam: runs inside the target transaction after every statement, before COMMIT. */
  beforeCommit?: () => void | Promise<void>;
}

/**
 * Applies `events` (a transaction-closed prefix in outbox id order, see
 * fetchUnsent) to `target` in ONE transaction.
 *   - Only the last event per row is applied (coalesceEvents).
 *   - Application order is chronological (id order), which already matches the
 *     FK dependency order users -> groups -> group_members -> bills ->
 *     bill_items -> item_assignments -> settlements; additionally every FK and
 *     unique constraint is DEFERRED to COMMIT (migration 0006 made them
 *     DEFERRABLE), so the checked state is the batch's final state only. The
 *     target's real constraints still reject a bad batch (it aborts whole).
 *   - `sw.sync_apply` makes the 0005/0006 triggers keep incoming updated_at /
 *     origin verbatim and write no outbox / deletion_log rows on the target.
 */
export async function applyEvents(
  target: Sql,
  events: OutboxEvent[],
  columns: ColumnsByTable,
  hooks: ApplyHooks = {},
): Promise<void> {
  if (events.length === 0) return;
  const latest = coalesceEvents(events);
  await target.begin(async (tx) => {
    await tx`SELECT set_config('sw.sync_apply', 'on', true)`;
    // Constraints are DEFERRABLE (migration 0006): checked once, at COMMIT.
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    const pending = latest.map((e) => {
      assertSyncedTable(e.tableName);
      if (e.op === "upsert") {
        if (!e.payload) throw new Error(`Outbox event ${e.id} is an upsert without a payload.`);
        return tx.unsafe(upsertSql(e.tableName, columns[e.tableName]), [tx.json(e.payload as postgres.JSONValue)]);
      }
      return tx.unsafe(deleteSql(e.tableName), [String(e.pk), e.at]);
    });
    await Promise.all(pending); // pipelined, executed in order on the one connection
    await hooks.beforeCommit?.();
  });
}
