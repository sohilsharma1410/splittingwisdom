import { SYNCED_TABLES, type SyncedTable } from "@splittingwisdom/shared";

/**
 * Pure merge planner for failback (plan S4.3 / S5.5): given what the Pi has
 * and what the standby has, decide which standby changes the Pi must take
 * over. No I/O. Everything is last-writer-wins by updated_at, with deletions
 * (tombstones from deletion_log) taking part in the comparison, and every
 * disagreement that is not a plain "one side is simply behind" is reported as
 * a conflict (kept in sync_conflicts for the owner).
 *
 * Timestamps are fixed-width UTC strings 'YYYY-MM-DDTHH:MI:SS.US', so plain
 * string comparison is exact to the microsecond.
 */

export interface RowInfo {
  id: number;
  /** updated_at, fixed-width UTC. */
  ts: string;
  origin: string;
  /** The whole row (to_jsonb), for content equality and for applying. */
  row: Record<string, unknown>;
  /** Canonical text of `row`. */
  text: string;
}

export interface TableSnapshot {
  rows: Map<number, RowInfo>;
  /** pk -> time of the (latest) deletion. */
  tombstones: Map<number, string>;
}
export type Snapshot = Record<SyncedTable, TableSnapshot>;

export const emptySnapshot = (): Snapshot =>
  Object.fromEntries(SYNCED_TABLES.map((t) => [t, { rows: new Map(), tombstones: new Map() }])) as Snapshot;

export interface RowRef {
  table: SyncedTable;
  id: number;
}
export interface Conflict extends RowRef {
  winner: "pi" | "standby";
  winnerTs: string | null;
  loserTs: string | null;
  note: string;
}
export interface Plan {
  /** Standby rows to write onto the Pi (insert or overwrite). */
  upserts: RowRef[];
  /** Rows to delete from the Pi. */
  deletes: RowRef[];
  conflicts: Conflict[];
  /** After the Pi is final, queue these so forward sync makes the standby follow. */
  converge: Array<RowRef & { op: "upsert" | "delete" }>;
  /** `${table}:${id}` keys where the Pi may legitimately still differ from the standby after the merge. */
  allowedDifferences: Set<string>;
  warnings: string[];
}

export const refKey = (r: RowRef) => `${r.table}:${r.id}`;

export function planMerge(input: {
  pi: Snapshot;
  standby: Snapshot;
  /** Last time the Pi confirmed its changes were on the standby (UTC fixed-width), or null if unknown. */
  watermark: string | null;
  /** Ids at/above this belong to the standby's id range. */
  standbyIdFloor?: number;
}): Plan {
  const W = input.watermark ?? "";
  const floor = input.standbyIdFloor ?? 1_000_000_000;
  const plan: Plan = { upserts: [], deletes: [], conflicts: [], converge: [], allowedDifferences: new Set(), warnings: [] };

  for (const table of SYNCED_TABLES) {
    const P = input.pi[table];
    const S = input.standby[table];
    const ids = new Set<number>([...P.rows.keys(), ...S.rows.keys()]);

    for (const id of [...ids].sort((a, b) => a - b)) {
      const p = P.rows.get(id);
      const s = S.rows.get(id);
      const ref: RowRef = { table, id };
      const conflict = (winner: "pi" | "standby", note: string) =>
        plan.conflicts.push({
          ...ref,
          winner,
          winnerTs: (winner === "pi" ? p?.ts : s?.ts) ?? null,
          loserTs: (winner === "pi" ? s?.ts : p?.ts) ?? null,
          note,
        });
      const allow = () => plan.allowedDifferences.add(refKey(ref));

      if (p && s) {
        if (p.text === s.text) continue;
        if (s.ts > p.ts) {
          if (p.ts > W) conflict("standby", "row changed on both sides since the last sync; standby is newer");
          plan.upserts.push(ref);
        } else {
          // Pi newer, or same timestamp with different content: the Pi (primary) keeps its row.
          if (s.ts > W || s.ts === p.ts) {
            conflict("pi", s.ts === p.ts ? "same updated_at, different content; Pi kept" : "row changed on both sides since the last sync; Pi is newer");
          }
          plan.converge.push({ ...ref, op: "upsert" });
          allow();
        }
        continue;
      }

      if (s && !p) {
        const tomb = P.tombstones.get(id);
        if (tomb !== undefined && tomb >= s.ts) {
          // Deleted on the Pi after the standby's version: the delete wins.
          plan.converge.push({ ...ref, op: "delete" });
          allow();
        } else {
          if (tomb !== undefined) conflict("standby", "row was deleted on the Pi but edited later on the standby; restored");
          if (s.origin === "standby" && id < floor) {
            plan.warnings.push(`${table}:${id} was created by the standby inside the Pi's id range`);
          }
          plan.upserts.push(ref);
        }
        continue;
      }

      if (p && !s) {
        const tomb = S.tombstones.get(id);
        if (tomb !== undefined && tomb >= p.ts) {
          plan.deletes.push(ref); // the standby deleted it after the Pi's last change
        } else if (tomb !== undefined) {
          conflict("pi", "row was deleted on the standby but changed later on the Pi; kept");
          plan.converge.push({ ...ref, op: "upsert" });
          allow();
        } else {
          allow(); // exists only on the Pi: not synced yet (its outbox events are still queued)
        }
      }
    }
  }
  return plan;
}
