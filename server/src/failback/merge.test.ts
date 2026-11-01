import { describe, it, expect } from "vitest";
import { planMerge, emptySnapshot, refKey, type RowInfo, type Snapshot } from "./merge.js";

const T = (n: number) => `2026-11-01T10:00:${String(n).padStart(2, "0")}.000000`;
const W = T(10); // last confirmed sync

function row(id: number, ts: string, extra: Record<string, unknown> = {}, origin = "pi"): RowInfo {
  const r = { id, updated_at: ts, origin, name: `n${id}`, ...extra };
  return { id, ts, origin, row: r, text: JSON.stringify(r) };
}
function snap(tables: Partial<Record<keyof Snapshot, { rows?: RowInfo[]; tombs?: Record<number, string> }>>): Snapshot {
  const s = emptySnapshot();
  for (const [t, v] of Object.entries(tables)) {
    const table = t as keyof Snapshot;
    for (const r of v?.rows ?? []) s[table].rows.set(r.id, r);
    for (const [pk, ts] of Object.entries(v?.tombs ?? {})) s[table].tombstones.set(Number(pk), ts);
  }
  return s;
}
const plan = (pi: Snapshot, standby: Snapshot, watermark: string | null = W) => planMerge({ pi, standby, watermark });

describe("planMerge", () => {
  it("identical rows need nothing", () => {
    const r = row(1, T(5));
    const p = plan(snap({ bills: { rows: [r] } }), snap({ bills: { rows: [r] } }));
    expect(p.upserts).toEqual([]);
    expect(p.deletes).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.allowedDifferences.size).toBe(0);
  });

  it("a row created on the standby is imported", () => {
    const p = plan(snap({}), snap({ bills: { rows: [row(1_000_000_001, T(20), {}, "standby")] } }));
    expect(p.upserts).toEqual([{ table: "bills", id: 1_000_000_001 }]);
    expect(p.conflicts).toEqual([]);
  });

  it("a standby edit of a row the Pi has not touched since the last sync is imported cleanly", () => {
    const p = plan(snap({ bills: { rows: [row(1, T(5))] } }), snap({ bills: { rows: [row(1, T(20), { name: "edited" }, "standby")] } }));
    expect(p.upserts).toEqual([{ table: "bills", id: 1 }]);
    expect(p.conflicts).toEqual([]);
  });

  it("changed on both sides: newer wins and a conflict is recorded (standby newer)", () => {
    const p = plan(snap({ bills: { rows: [row(1, T(12), { name: "pi edit" })] } }), snap({ bills: { rows: [row(1, T(20), { name: "sb edit" })] } }));
    expect(p.upserts).toEqual([{ table: "bills", id: 1 }]);
    expect(p.conflicts).toMatchObject([{ table: "bills", id: 1, winner: "standby", winnerTs: T(20), loserTs: T(12) }]);
  });

  it("changed on both sides: Pi newer keeps its row, records a conflict, and converges the standby", () => {
    const p = plan(snap({ bills: { rows: [row(1, T(30), { name: "pi edit" })] } }), snap({ bills: { rows: [row(1, T(20), { name: "sb edit" })] } }));
    expect(p.upserts).toEqual([]);
    expect(p.conflicts).toMatchObject([{ winner: "pi" }]);
    expect(p.converge).toEqual([{ table: "bills", id: 1, op: "upsert" }]);
    expect(p.allowedDifferences.has("bills:1")).toBe(true);
  });

  it("a standby row that is merely stale (Pi changed it, standby did not touch it) is no conflict", () => {
    const p = plan(snap({ bills: { rows: [row(1, T(30))] } }), snap({ bills: { rows: [row(1, T(5), { name: "old" })] } }));
    expect(p.conflicts).toEqual([]);
    expect(p.upserts).toEqual([]);
  });

  it("same updated_at with different content: Pi wins, conflict recorded", () => {
    const p = plan(snap({ bills: { rows: [row(1, T(30), { name: "a" })] } }), snap({ bills: { rows: [row(1, T(30), { name: "b" })] } }));
    expect(p.conflicts).toMatchObject([{ winner: "pi" }]);
    expect(p.upserts).toEqual([]);
  });

  it("a deletion made on the standby is replayed on the Pi", () => {
    const p = plan(snap({ bills: { rows: [row(7, T(5))] } }), snap({ bills: { tombs: { 7: T(25) } } }));
    expect(p.deletes).toEqual([{ table: "bills", id: 7 }]);
    expect(p.conflicts).toEqual([]);
  });

  it("deleted on the standby but edited later on the Pi: the edit survives (conflict) and the standby is repaired", () => {
    const p = plan(snap({ bills: { rows: [row(7, T(40))] } }), snap({ bills: { tombs: { 7: T(25) } } }));
    expect(p.deletes).toEqual([]);
    expect(p.conflicts).toMatchObject([{ table: "bills", id: 7, winner: "pi" }]);
    expect(p.converge).toEqual([{ table: "bills", id: 7, op: "upsert" }]);
  });

  it("deleted on the Pi after the standby's version: stays deleted, standby told to delete", () => {
    const p = plan(snap({ bills: { tombs: { 7: T(30) } } }), snap({ bills: { rows: [row(7, T(20))] } }));
    expect(p.upserts).toEqual([]);
    expect(p.converge).toEqual([{ table: "bills", id: 7, op: "delete" }]);
    expect(p.conflicts).toEqual([]);
  });

  it("deleted on the Pi but edited later on the standby: restored with a conflict", () => {
    const p = plan(snap({ bills: { tombs: { 7: T(15) } } }), snap({ bills: { rows: [row(7, T(20))] } }));
    expect(p.upserts).toEqual([{ table: "bills", id: 7 }]);
    expect(p.conflicts).toMatchObject([{ winner: "standby" }]);
  });

  it("rows that exist only on the Pi (not synced yet) are left alone and explained", () => {
    const p = plan(snap({ bills: { rows: [row(9, T(50))] } }), snap({}));
    expect(p.upserts).toEqual([]);
    expect(p.deletes).toEqual([]);
    expect(p.allowedDifferences.has("bills:9")).toBe(true);
  });

  it("warns about standby-created rows inside the Pi's id range", () => {
    const p = plan(snap({}), snap({ users: { rows: [row(5, T(20), {}, "standby")] } }));
    expect(p.warnings[0]).toContain("users:5");
  });

  it("with an unknown watermark every disagreement is treated as a both-sides change", () => {
    const p = plan(snap({ bills: { rows: [row(1, T(12))] } }), snap({ bills: { rows: [row(1, T(20), { name: "x" })] } }), null);
    expect(p.conflicts).toHaveLength(1);
  });

  it("refKey is stable", () => {
    expect(refKey({ table: "bill_items", id: 3 })).toBe("bill_items:3");
  });
});
