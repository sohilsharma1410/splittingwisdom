import { splitEqually, allocateProportionally } from "./money.js";

/**
 * Inputs are plain data, not DB rows — server endpoints map query results
 * into these shapes and call computeBalances. This keeps the money math
 * testable without a database.
 */
export type SplitType = "equal" | "percentage" | "ratio" | "custom";

export interface ItemAssignmentForBalance {
  memberId: number;
  splitType: SplitType;
  percentage?: number | null;
  ratio?: number | null;
  customAmount?: number | null;
}

export interface BillItemForBalance {
  price: number;
  assignments: ItemAssignmentForBalance[];
}

/**
 * Splits one item's price among its assignees per their split type. All
 * assignments on the same item share one split type (the assignment editor
 * has one split-type selector per item, not per person) — the first
 * assignment's type governs. An item with no assignments splits to nobody
 * (unassigned items are excluded from balances, per CLAUDE.md/phase 2 spec).
 */
export function computeItemShares(item: BillItemForBalance): Map<number, number> {
  if (item.assignments.length === 0) return new Map();
  const splitType = item.assignments[0].splitType;

  switch (splitType) {
    case "equal":
      return splitEqually(
        item.price,
        item.assignments.map((a) => a.memberId),
      );
    case "percentage": {
      const weights = new Map(item.assignments.map((a) => [a.memberId, a.percentage ?? 0]));
      return allocateProportionally(item.price, weights);
    }
    case "ratio": {
      const weights = new Map(item.assignments.map((a) => [a.memberId, a.ratio ?? 0]));
      return allocateProportionally(item.price, weights);
    }
    case "custom":
      return new Map(item.assignments.map((a) => [a.memberId, a.customAmount ?? 0]));
  }
}

export interface BillForBalance {
  paidByMemberId: number;
  taxAmount: number;
  tipAmount: number;
  serviceFeeAmount: number;
  discountAmount: number;
  items: BillItemForBalance[];
}

export interface SettlementForBalance {
  payerMemberId: number;
  recipientMemberId: number;
  amount: number;
}

export interface PairwiseBalance {
  memberIdA: number;
  memberIdB: number;
  /** Positive: A owes B this many paise. Negative: B owes A. Zero: settled. */
  netAmount: number;
}

/** One member's full charge breakdown on a bill — item share, each charge
 * type's proportional allocation, and the total. Members with no assigned
 * items don't appear (they owe nothing on this bill, per CLAUDE.md rule 5). */
export interface BillBreakdownRow {
  memberId: number;
  itemShare: number;
  taxShare: number;
  tipShare: number;
  serviceFeeShare: number;
  discountShare: number;
  total: number;
}

/**
 * Per-member breakdown for one bill: aggregates every item's share per
 * member (via computeItemShares), then allocates tax/tip/fee/discount
 * proportionally to that aggregate — CLAUDE.md money rule 5. This is the
 * single source of truth for "how was this calculated"; computeBalances and
 * every server "breakdown" endpoint should call this rather than
 * re-deriving shares ad hoc.
 */
export function computeBillBreakdown(bill: BillForBalance): BillBreakdownRow[] {
  const aggregateItemShares = new Map<number, number>();
  for (const item of bill.items) {
    const shares = computeItemShares(item);
    for (const [memberId, share] of shares) {
      aggregateItemShares.set(memberId, (aggregateItemShares.get(memberId) ?? 0) + share);
    }
  }
  if (aggregateItemShares.size === 0) return [];

  const taxShares = allocateProportionally(bill.taxAmount, aggregateItemShares);
  const tipShares = allocateProportionally(bill.tipAmount, aggregateItemShares);
  const feeShares = allocateProportionally(bill.serviceFeeAmount, aggregateItemShares);
  const discountShares = allocateProportionally(bill.discountAmount, aggregateItemShares);

  return [...aggregateItemShares.keys()]
    .sort((a, b) => a - b)
    .map((memberId) => {
      const itemShare = aggregateItemShares.get(memberId)!;
      const taxShare = taxShares.get(memberId) ?? 0;
      const tipShare = tipShares.get(memberId) ?? 0;
      const serviceFeeShare = feeShares.get(memberId) ?? 0;
      const discountShare = discountShares.get(memberId) ?? 0;
      return {
        memberId,
        itemShare,
        taxShare,
        tipShare,
        serviceFeeShare,
        discountShare,
        total: itemShare + taxShare + tipShare + serviceFeeShare - discountShare,
      };
    });
}

/**
 * Computes every pairwise balance implied by a set of bills and settlements
 * within a group. Pure and deterministic: same inputs always produce the
 * same output, with no DB or clock access. This is the single source of
 * truth for "who owes whom" (CLAUDE.md money rule #4) — server endpoints
 * and the client's "how was this calculated" views should always go through
 * this function rather than re-deriving balances ad hoc.
 */
export function computeBalances(
  bills: BillForBalance[],
  settlements: SettlementForBalance[],
): PairwiseBalance[] {
  // ledger.get(ower)?.get(owedTo) = paise `ower` owes `owedTo`
  const ledger = new Map<number, Map<number, number>>();

  function addDebt(owerId: number, owedToId: number, amount: number) {
    if (owerId === owedToId || amount === 0) return;
    if (!ledger.has(owerId)) ledger.set(owerId, new Map());
    const inner = ledger.get(owerId)!;
    inner.set(owedToId, (inner.get(owedToId) ?? 0) + amount);
  }

  for (const bill of bills) {
    const breakdown = computeBillBreakdown(bill);
    for (const row of breakdown) {
      addDebt(row.memberId, bill.paidByMemberId, row.total);
    }
  }

  for (const settlement of settlements) {
    addDebt(settlement.payerMemberId, settlement.recipientMemberId, -settlement.amount);
  }

  const allMemberIds = new Set<number>();
  ledger.forEach((inner, ower) => {
    allMemberIds.add(ower);
    inner.forEach((_amount, owedTo) => allMemberIds.add(owedTo));
  });
  const sortedIds = [...allMemberIds].sort((a, b) => a - b);

  const pairs: PairwiseBalance[] = [];
  for (let i = 0; i < sortedIds.length; i++) {
    for (let j = i + 1; j < sortedIds.length; j++) {
      const a = sortedIds[i];
      const b = sortedIds[j];
      const aOwesB = ledger.get(a)?.get(b) ?? 0;
      const bOwesA = ledger.get(b)?.get(a) ?? 0;
      if (aOwesB === 0 && bOwesA === 0) continue;
      pairs.push({ memberIdA: a, memberIdB: b, netAmount: aOwesB - bOwesA });
    }
  }

  return pairs;
}

/** Finds the net balance between two specific members, or 0 if unrelated. */
export function getPairwiseBalance(
  balances: PairwiseBalance[],
  memberIdA: number,
  memberIdB: number,
): number {
  const [lo, hi] = memberIdA < memberIdB ? [memberIdA, memberIdB] : [memberIdB, memberIdA];
  const pair = balances.find((p) => p.memberIdA === lo && p.memberIdB === hi);
  if (!pair) return 0;
  return memberIdA < memberIdB ? pair.netAmount : -pair.netAmount;
}
