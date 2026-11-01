// Turns spoken shares into the assignments the bill API takes. Speech only ever says who and how
// many units, never an amount: the shared split code does all the money.
import type { ItemAssignmentInput } from "@/hooks/use-bills";

export interface Share {
  memberId: number;
  units: number;
}

/** Everyone one unit: an equal split. Different units (two for me, one for Priya) split by ratio. */
export function assignmentsFromShares(shares: Share[]): ItemAssignmentInput[] {
  const ordered = [...shares].sort((a, b) => a.memberId - b.memberId);
  const equal = ordered.every((s) => s.units === ordered[0].units);
  return ordered.map((s) => (equal ? { memberId: s.memberId, splitType: "equal" as const } : { memberId: s.memberId, splitType: "ratio" as const, ratio: s.units }));
}

/** "Karan" / "Karan ×2" for a list of shares, for the chips and the preview. */
export function describeShares(shares: Share[], nameOf: (memberId: number) => string): string {
  const equal = shares.every((s) => s.units === shares[0].units);
  return shares.map((s) => (equal || s.units === 1 ? nameOf(s.memberId) : `${nameOf(s.memberId)} ×${s.units}`)).join(", ");
}
