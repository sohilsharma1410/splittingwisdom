import { SYNCED_TABLES } from "@splittingwisdom/shared";
import type postgres from "postgres";
import type { Sql } from "./client.js";
import type { OutboxEvent } from "./apply.js";

interface OutboxRow {
  id: string;
  table_name: OutboxEvent["tableName"];
  pk: string;
  op: OutboxEvent["op"];
  payload: Record<string, unknown> | null;
  at: string;
}

type Tx = postgres.TransactionSql;

const toEvent = (r: OutboxRow): OutboxEvent => ({
  id: Number(r.id),
  tableName: r.table_name,
  pk: Number(r.pk),
  op: r.op,
  payload: r.payload,
  at: r.at,
});

/**
 * The oldest unsent events, as a TRANSACTION-CLOSED prefix in id order:
 * roughly `limit` events, extended until every transaction that has an event
 * in the batch has ALL its unsent events in it. A batch therefore never holds
 * half of a cascade (e.g. a parent's DELETE without its children's), and the
 * rows it carries never depend on a transaction that is not in it: a
 * dependent statement only runs after the transaction it depends on has
 * committed, so all of that transaction's events have lower ids.
 *
 * Read in one REPEATABLE READ snapshot, and selected by `sent_at IS NULL`
 * (never by a "greater than last id" cursor): ids are taken at trigger time but
 * become visible at commit time, so a lower id can legitimately show up later.
 */
export async function fetchUnsent(source: Sql, limit: number): Promise<OutboxEvent[]> {
  return source.begin("isolation level repeatable read read only", async (tx: Tx) => {
    const events = (
      await tx<OutboxRow[]>`
        SELECT id::text AS id, table_name, pk::text AS pk, op, payload, "at"::text AS "at"
        FROM sync_outbox WHERE sent_at IS NULL
        ORDER BY sync_outbox.id LIMIT ${limit}`
    ).map(toEvent);
    if (events.length === 0) return events;

    const seenXids = new Set<string>();
    let scannedXids = 0;
    for (;;) {
      // Which transactions are in the batch so far?  (xid is read separately to keep OutboxEvent lean.)
      const ids = events.map((e) => e.id);
      const rows = await tx<{ xid: string }[]>`
        SELECT DISTINCT xid::text AS xid FROM sync_outbox
        WHERE id IN (SELECT jsonb_array_elements_text(${tx.json(ids)}::jsonb)::bigint)`;
      for (const r of rows) seenXids.add(r.xid);
      if (seenXids.size === scannedXids) break;
      scannedXids = seenXids.size;

      const [{ max }] = await tx<{ max: string | null }[]>`
        SELECT max(id)::text AS max FROM sync_outbox
        WHERE sent_at IS NULL
          AND xid IN (SELECT jsonb_array_elements_text(${tx.json([...seenXids])}::jsonb)::bigint)`;
      const last = events[events.length - 1].id;
      if (max === null || Number(max) <= last) break;
      const more = await tx<OutboxRow[]>`
        SELECT id::text AS id, table_name, pk::text AS pk, op, payload, "at"::text AS "at"
        FROM sync_outbox WHERE sent_at IS NULL AND id > ${last} AND id <= ${max}
        ORDER BY sync_outbox.id`;
      events.push(...more.map(toEvent));
    }
    return events;
  });
}

/** Marks exactly these events shipped (called only after the target COMMITted). */
export async function markSent(source: Sql, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await source`
    UPDATE sync_outbox SET sent_at = now()
    WHERE sent_at IS NULL
      AND id IN (SELECT jsonb_array_elements_text(${source.json(ids)}::jsonb)::bigint)`;
}

export async function purgeSent(source: Sql, olderThanMinutes: number): Promise<number> {
  const rows = await source`
    DELETE FROM sync_outbox
    WHERE sent_at IS NOT NULL AND sent_at < now() - make_interval(mins => ${olderThanMinutes})
    RETURNING 1`;
  return rows.length;
}

export interface OutboxLag {
  pending: number;
  /** Age of the oldest unsent event; 0 when nothing is waiting. */
  lagSeconds: number;
}

export async function readLag(source: Sql): Promise<OutboxLag> {
  const [row] = await source<{ pending: number; lag: number }[]>`
    SELECT count(*)::int AS pending,
           COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - min("at"))), 0)::float8 AS lag
    FROM sync_outbox WHERE sent_at IS NULL`;
  return { pending: row.pending, lagSeconds: Math.max(0, Math.round(row.lag * 10) / 10) };
}

/** `at` = the instant (timestamptz text) at which the outbox was known to be fully delivered; default now(). */
export async function recordSuccess(source: Sql, at?: string): Promise<void> {
  await source`
    UPDATE sync_status SET last_success_at = COALESCE(${at ?? null}::timestamptz, now()), last_error = NULL, updated_at = now()
    WHERE id = 1`;
}

export async function recordFailure(source: Sql, message: string): Promise<void> {
  await source`
    UPDATE sync_status SET last_error = ${message.slice(0, 500)}, last_error_at = now(), updated_at = now()
    WHERE id = 1`;
}

/**
 * Bootstrap / repair: queues an upsert for every row currently in the synced
 * tables (parents first) so the agent pushes a full copy. Safe to repeat —
 * applying is idempotent and LWW-guarded.
 */
export async function enqueueFullResync(source: Sql): Promise<number> {
  let total = 0;
  await source.begin(async (tx) => {
    for (const table of SYNCED_TABLES) {
      const rows = await tx.unsafe(
        `INSERT INTO sync_outbox (table_name, pk, op, payload)
         SELECT '${table}', t.id, 'upsert', to_jsonb(t) FROM "${table}" t ORDER BY t.id
         RETURNING 1`,
      );
      total += rows.length;
    }
  });
  return total;
}

/** Everything currently pending is considered delivered (used after a failback that already reconciled the data). */
export async function discardPending(source: Sql): Promise<number> {
  const rows = await source`UPDATE sync_outbox SET sent_at = now() WHERE sent_at IS NULL RETURNING 1`;
  return rows.length;
}
