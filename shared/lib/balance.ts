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

/** One of several people who paid a bill, and how much they paid. */
export interface BillPayer {
  memberId: number;
  amount: number;
}

export interface BillForBalance {
  /** The payer when one person paid. With several payers, the one who paid most (for display only). */
  paidByMemberId: number;
  /**
   * null: paidByMemberId paid the whole bill. Otherwise everyone who paid and how much, adding up
   * to the bill's grand total exactly.
   */
  payers: BillPayer[] | null;
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

/** One debt a bill creates: `debtorId` owes `creditorId` this many paise. */
export interface BillDebt {
  debtorId: number;
  creditorId: number;
  amount: number;
}

/**
 * Who owes whom because of one bill. The single source of truth for a bill's debts: the balances
 * and the bill's Settled/Pending status both use it.
 *
 * One payer: everyone else owes the payer their share, exactly as before several payers existed.
 *
 * Several payers: each payer is first credited with part of what was assigned, in proportion to
 * what they paid (so anything assigned to nobody is absorbed by the payers the same way). Each
 * person's balance on the bill is then credit minus share. Those below zero owe those above zero,
 * each debt in proportion to what the creditor is owed, rounded to whole paise so every person's
 * debts add up to exactly what they owe and every creditor receives exactly what they're owed.
 * Someone who paid exactly their own share owes and is owed nothing.
 */
export function computeBillDebts(bill: BillForBalance): BillDebt[] {
  const breakdown = computeBillBreakdown(bill);

  if (!bill.payers || bill.payers.length === 0) {
    return breakdown
      .filter((row) => row.memberId !== bill.paidByMemberId && row.total !== 0)
      .map((row) => ({ debtorId: row.memberId, creditorId: bill.paidByMemberId, amount: row.total }));
  }

  const assigned = breakdown.reduce((sum, row) => sum + row.total, 0);
  const credit =
    assigned > 0
      ? allocateProportionally(assigned, new Map(bill.payers.map((p) => [p.memberId, p.amount])))
      : new Map<number, number>();
  const net = new Map<number, number>();
  for (const [memberId, amount] of credit) net.set(memberId, amount);
  for (const row of breakdown) net.set(row.memberId, (net.get(row.memberId) ?? 0) - row.total);

  const ids = [...net.keys()].sort((a, b) => a - b);
  const debtors = ids.filter((id) => net.get(id)! < 0).map((id) => ({ id, owes: -net.get(id)! }));
  const creditors = ids.filter((id) => net.get(id)! > 0).map((id) => ({ id, owed: net.get(id)! }));
  const totalOwed = creditors.reduce((sum, c) => sum + c.owed, 0);
  if (totalOwed === 0) return [];

  // Proportional amounts, rounded down. BigInt keeps the products exact for any bill size.
  const cells = debtors.map((d) =>
    creditors.map((c) => Number((BigInt(d.owes) * BigInt(c.owed)) / BigInt(totalOwed))),
  );
  // Rounding leaves each debtor a few paise short, and each creditor too, by the same total.
  // Hand those paise out in member-id order, which keeps both sides exact.
  const debtorLeft = debtors.map((d, i) => d.owes - cells[i].reduce((a, b) => a + b, 0));
  const creditorLeft = creditors.map((c, j) => c.owed - cells.reduce((sum, row) => sum + row[j], 0));
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const give = Math.min(debtorLeft[i], creditorLeft[j]);
    cells[i][j] += give;
    debtorLeft[i] -= give;
    creditorLeft[j] -= give;
    if (debtorLeft[i] === 0) i++;
    if (creditorLeft[j] === 0) j++;
  }

  const debts: BillDebt[] = [];
  debtors.forEach((d, di) =>
    creditors.forEach((c, ci) => {
      if (cells[di][ci] > 0) debts.push({ debtorId: d.id, creditorId: c.id, amount: cells[di][ci] });
    }),
  );
  return debts;
}

/** What each person paid towards a bill whose grand total is given. */
export function billPayments(bill: Pick<BillForBalance, "paidByMemberId" | "payers">, grandTotal: number): BillPayer[] {
  return bill.payers && bill.payers.length > 0 ? bill.payers : [{ memberId: bill.paidByMemberId, amount: grandTotal }];
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
    for (const debt of computeBillDebts(bill)) addDebt(debt.debtorId, debt.creditorId, debt.amount);
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

/** A bill plus its grand total, for summing what a group spent. */
export interface BillForSummary extends BillForBalance {
  grandTotal: number;
}

/** One member's money in one group, every figure derived from the bills and settlements. */
export interface MemberSummary {
  /** Everything the group spent: the sum of every bill's grand total. */
  groupSpent: number;
  /** The part of groupSpent assigned to nobody, so it is in nobody's share. */
  unassigned: number;
  /** What this member had: their share of every bill, tax, tip, fees and discounts included. */
  share: number;
  /** What this member paid towards bills: whole grand totals, or their part when several paid. Settlements are not included. */
  paid: number;
  /** After settlements. Positive: the others owe this member overall. Negative: they owe the others. */
  net: number;
  /** This member's share of each bill, in the order the bills were given. */
  billShares: number[];
}

/**
 * Sums one member's position in a group. Shares come from computeBillBreakdown and the net from
 * computeBalances, so these figures always agree with "who owes whom". With every item assigned
 * and no settlements, net = paid - share exactly.
 */
export function summarizeMember(
  bills: BillForSummary[],
  settlements: SettlementForBalance[],
  memberId: number,
): MemberSummary {
  let groupSpent = 0;
  let unassigned = 0;
  let paid = 0;
  const billShares = bills.map((bill) => {
    const rows = computeBillBreakdown(bill);
    const assigned = rows.reduce((sum, row) => sum + row.total, 0);
    groupSpent += bill.grandTotal;
    unassigned += bill.grandTotal - assigned;
    paid += billPayments(bill, bill.grandTotal).find((p) => p.memberId === memberId)?.amount ?? 0;
    return rows.find((row) => row.memberId === memberId)?.total ?? 0;
  });

  let net = 0;
  for (const pair of computeBalances(bills, settlements)) {
    if (pair.memberIdA === memberId) net -= pair.netAmount;
    else if (pair.memberIdB === memberId) net += pair.netAmount;
  }

  return {
    groupSpent,
    unassigned,
    share: billShares.reduce((sum, share) => sum + share, 0),
    paid,
    net,
    billShares,
  };
}
