import type { ActivePrimary, NodeOrigin } from "@splittingwisdom/shared";
import type { Sql } from "../sync/client.js";

export interface SystemStateRow {
  activePrimary: ActivePrimary;
  epoch: number;
  updatedAt: Date;
}

export interface HeartbeatRow {
  node: NodeOrigin;
  beatAt: Date;
  lastSyncAt: Date | null;
  lagSeconds: number | null;
}

/** Reads the single system_state row. Throws if the table/row is missing (unmigrated authority). */
export async function readSystemState(authority: Sql): Promise<SystemStateRow> {
  const [row] = await authority<{ active_primary: ActivePrimary; epoch: number; updated_at: Date }[]>`
    SELECT active_primary, epoch, updated_at FROM system_state WHERE id = 1`;
  if (!row) throw new Error("system_state has no row — run migration 0007 on the standby database.");
  return { activePrimary: row.active_primary, epoch: row.epoch, updatedAt: row.updated_at };
}

/**
 * Compare-and-set transition: succeeds only if nobody changed the state since
 * `expectedEpoch` was read, and always bumps the epoch (the fencing token).
 * Returns the new row, or null if we lost the race.
 */
export async function transitionSystemState(
  authority: Sql,
  expectedEpoch: number,
  to: ActivePrimary,
): Promise<SystemStateRow | null> {
  const [row] = await authority<{ active_primary: ActivePrimary; epoch: number; updated_at: Date }[]>`
    UPDATE system_state
    SET active_primary = ${to}, epoch = epoch + 1, updated_at = now()
    WHERE id = 1 AND epoch = ${expectedEpoch}
    RETURNING active_primary, epoch, updated_at`;
  return row ? { activePrimary: row.active_primary, epoch: row.epoch, updatedAt: row.updated_at } : null;
}

export async function writeHeartbeat(
  authority: Sql,
  node: NodeOrigin,
  info: { lastSyncAt: Date | null; lagSeconds: number | null },
): Promise<void> {
  await authority`
    INSERT INTO node_heartbeat (node, beat_at, last_sync_at, lag_seconds)
    VALUES (${node}, now(), ${info.lastSyncAt}, ${info.lagSeconds})
    ON CONFLICT (node) DO UPDATE
      SET beat_at = now(), last_sync_at = EXCLUDED.last_sync_at, lag_seconds = EXCLUDED.lag_seconds`;
}

export async function readHeartbeat(authority: Sql, node: NodeOrigin): Promise<(HeartbeatRow & { ageMs: number }) | null> {
  const [row] = await authority<
    { node: NodeOrigin; beat_at: Date; last_sync_at: Date | null; lag_seconds: number | null; age_ms: number }[]
  >`
    SELECT node, beat_at, last_sync_at, lag_seconds,
           (EXTRACT(EPOCH FROM (clock_timestamp() - beat_at)) * 1000)::float8 AS age_ms
    FROM node_heartbeat WHERE node = ${node}`;
  if (!row) return null;
  return { node: row.node, beatAt: row.beat_at, lastSyncAt: row.last_sync_at, lagSeconds: row.lag_seconds, ageMs: row.age_ms };
}
