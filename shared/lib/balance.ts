import { splitEqually, allocateProportionally } from "./money.js";

/**
 * Inputs are plain data, not DB rows — server endpoints map query results
 * into these shapes and call computeBalances. This keeps the money math
 * testable without a database.
 *
 * `memberIds` on an item is Phase 1's equal-split assignment list. Later
 * phases add percentage/ratio/custom split data to BillItemForBalance
 * without changing this function's contract.
 */
export interface BillItemForBalance {
  price: number;
  memberIds: number[];
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
    const aggregateItemShares = new Map<number, number>();
    for (const item of bill.items) {
      if (item.memberIds.length === 0) continue;
      const shares = splitEqually(item.price, item.memberIds);
      for (const [memberId, share] of shares) {
        aggregateItemShares.set(memberId, (aggregateItemShares.get(memberId) ?? 0) + share);
      }
    }
    if (aggregateItemShares.size === 0) continue;

    const taxShares = allocateProportionally(bill.taxAmount, aggregateItemShares);
    const tipShares = allocateProportionally(bill.tipAmount, aggregateItemShares);
    const feeShares = allocateProportionally(bill.serviceFeeAmount, aggregateItemShares);
    const discountShares = allocateProportionally(bill.discountAmount, aggregateItemShares);

    for (const [memberId, itemShare] of aggregateItemShares) {
      const total =
        itemShare +
        (taxShares.get(memberId) ?? 0) +
        (tipShares.get(memberId) ?? 0) +
        (feeShares.get(memberId) ?? 0) -
        (discountShares.get(memberId) ?? 0);
      addDebt(memberId, bill.paidByMemberId, total);
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
