/**
 * Settlement rules and the debt-simplification suggestion layer. Pure and
 * deterministic (no DB, no clock) like balance.ts — the server calls these
 * to enforce the rules; the client calls them to pre-fill and cap the dialog.
 * All amounts are integer paise.
 */
import {
  computeBillBreakdown,
  getPairwiseBalance,
  type BillForBalance,
  type PairwiseBalance,
  type SettlementForBalance,
} from "./balance.js";
import { formatPaise } from "./money.js";

// ---------------------------------------------------------------------------
// Net positions and the settlement cap
// ---------------------------------------------------------------------------

/** Each member's net position in the group: positive = owed money overall. */
export function netPositions(pairwise: PairwiseBalance[]): Map<number, number> {
  const net = new Map<number, number>();
  for (const { memberIdA, memberIdB, netAmount } of pairwise) {
    // netAmount > 0 means A owes B.
    net.set(memberIdA, (net.get(memberIdA) ?? 0) - netAmount);
    net.set(memberIdB, (net.get(memberIdB) ?? 0) + netAmount);
  }
  return net;
}

/** What `payer` currently owes `recipient` directly (never negative). */
export function directDebt(pairwise: PairwiseBalance[], payerId: number, recipientId: number): number {
  return Math.max(0, getPairwiseBalance(pairwise, payerId, recipientId));
}

/**
 * The most `payer` may record paying `recipient`:
 *  - a real pairwise debt between them can always be paid off, or
 *  - a payment that is part of settling the group's net positions (what
 *    "simplify debts" suggests, where payer owes someone else) is allowed up
 *    to the payer's overall debt and the recipient's overall credit.
 * Anything beyond both is an overpayment and is rejected.
 */
export function maxSettlementAmount(pairwise: PairwiseBalance[], payerId: number, recipientId: number): number {
  if (payerId === recipientId) return 0;
  const net = netPositions(pairwise);
  const payerDebt = Math.max(0, -(net.get(payerId) ?? 0));
  const recipientCredit = Math.max(0, net.get(recipientId) ?? 0);
  return Math.max(directDebt(pairwise, payerId, recipientId), Math.min(payerDebt, recipientCredit));
}

export type SettlementCheck =
  | { ok: true; max: number }
  | { ok: false; max: number; reason: "invalid-amount" | "same-person" | "nothing-owed" | "exceeds"; message: string };

export function checkSettlement(
  pairwise: PairwiseBalance[],
  payerId: number,
  recipientId: number,
  amount: number,
): SettlementCheck {
  const max = maxSettlementAmount(pairwise, payerId, recipientId);
  if (payerId === recipientId) {
    return { ok: false, max, reason: "same-person", message: "You can't settle with yourself." };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, max, reason: "invalid-amount", message: "Enter an amount greater than zero." };
  }
  if (max === 0) {
    return { ok: false, max, reason: "nothing-owed", message: "Nothing is owed between these two." };
  }
  if (amount > max) {
    return { ok: false, max, reason: "exceeds", message: `That's more than is owed. The most you can settle is ${formatPaise(max)}.` };
  }
  return { ok: true, max };
}

// ---------------------------------------------------------------------------
// Settling with a person who shares several groups with you
// ---------------------------------------------------------------------------

export interface GroupDebtLine {
  groupId: number;
  payerMemberId: number;
  recipientMemberId: number;
  /** What the payer owes the recipient in this group (> 0). */
  owed: number;
}

export interface SettlementAllocation {
  groupId: number;
  payerMemberId: number;
  recipientMemberId: number;
  amount: number;
}

/**
 * Splits one payment across the groups where the payer actually owes the
 * recipient — lowest group id first, so the result is reproducible. One
 * settlement row is recorded per group (settlements are group-scoped).
 * `remainder` > 0 means the amount exceeded what was owed in these groups;
 * callers cap the amount first, so a non-zero remainder is a bug to reject.
 */
export function allocateAcrossGroups(
  lines: GroupDebtLine[],
  amount: number,
): { allocations: SettlementAllocation[]; remainder: number } {
  let remaining = amount;
  const allocations: SettlementAllocation[] = [];
  for (const line of [...lines].filter((l) => l.owed > 0).sort((a, b) => a.groupId - b.groupId)) {
    if (remaining <= 0) break;
    const take = Math.min(line.owed, remaining);
    allocations.push({
      groupId: line.groupId,
      payerMemberId: line.payerMemberId,
      recipientMemberId: line.recipientMemberId,
      amount: take,
    });
    remaining -= take;
  }
  return { allocations, remainder: remaining };
}

// ---------------------------------------------------------------------------
// Per-bill status: Settled / Pending, derived — never stored
// ---------------------------------------------------------------------------

export interface BillForStatus extends BillForBalance {
  id: number;
  /** Oldest first; ties broken by id. Payments are applied to the oldest bills first. */
  sortKey: number;
}

export type BillSettlementStatus = "pending" | "settled";

/**
 * A bill is Settled when every pairwise amount it created is covered. For
 * each ordered pair (debtor → payer), credit is the payments debtor made to
 * payer plus whatever payer owes debtor on other bills (they cancel out), and
 * that credit pays that pair's bills oldest-first. A bill that created no
 * debt (nobody but the payer was on it) has nothing outstanding: Settled.
 */
export function computeBillSettlementStatuses(
  bills: BillForStatus[],
  settlements: SettlementForBalance[],
): Map<number, BillSettlementStatus> {
  const ordered = [...bills].sort((a, b) => a.sortKey - b.sortKey || a.id - b.id);
  const key = (debtor: number, creditor: number) => `${debtor}>${creditor}`;

  const dues = new Map<string, { billId: number; amount: number }[]>();
  for (const bill of ordered) {
    for (const row of computeBillBreakdown(bill)) {
      if (row.memberId === bill.paidByMemberId || row.total <= 0) continue;
      const k = key(row.memberId, bill.paidByMemberId);
      if (!dues.has(k)) dues.set(k, []);
      dues.get(k)!.push({ billId: bill.id, amount: row.total });
    }
  }

  const paidDirect = new Map<string, number>();
  for (const s of settlements) {
    const k = key(s.payerMemberId, s.recipientMemberId);
    paidDirect.set(k, (paidDirect.get(k) ?? 0) + s.amount);
  }
  const totalDue = (k: string) => (dues.get(k) ?? []).reduce((sum, d) => sum + d.amount, 0);

  const status = new Map<number, BillSettlementStatus>(ordered.map((b) => [b.id, "settled"]));
  for (const [k, list] of dues) {
    const [debtor, creditor] = k.split(">").map(Number);
    let credit = (paidDirect.get(k) ?? 0) + totalDue(key(creditor, debtor));
    for (const due of list) {
      const covered = Math.min(credit, due.amount);
      credit -= covered;
      if (covered < due.amount) status.set(due.billId, "pending");
    }
  }
  return status;
}

// ---------------------------------------------------------------------------
// Debt simplification — a suggestion layer only; it never touches the ledger
// ---------------------------------------------------------------------------

export interface SuggestedPayment {
  fromMemberId: number;
  toMemberId: number;
  amount: number;
}

/**
 * The minimal-ish set of payments that settles everyone's net position:
 * repeatedly match the largest debtor with the largest creditor (greedy
 * min-cash-flow). Ties go to the lowest member id so the same balances always
 * give the same suggestions. Total money moved equals the total owed overall.
 */
export function simplifyDebts(pairwise: PairwiseBalance[]): SuggestedPayment[] {
  const net = netPositions(pairwise);
  const byAmountThenId = (a: [number, number], b: [number, number]) => b[1] - a[1] || a[0] - b[0];
  const creditors = [...net].filter(([, v]) => v > 0).sort(byAmountThenId);
  const debtors = [...net].filter(([, v]) => v < 0).map(([id, v]): [number, number] => [id, -v]).sort(byAmountThenId);

  const payments: SuggestedPayment[] = [];
  while (creditors.length > 0 && debtors.length > 0) {
    const [debtorId, owes] = debtors[0];
    const [creditorId, owed] = creditors[0];
    const amount = Math.min(owes, owed);
    payments.push({ fromMemberId: debtorId, toMemberId: creditorId, amount });

    debtors[0] = [debtorId, owes - amount];
    creditors[0] = [creditorId, owed - amount];
    if (debtors[0][1] === 0) debtors.shift();
    if (creditors[0][1] === 0) creditors.shift();
    debtors.sort(byAmountThenId);
    creditors.sort(byAmountThenId);
  }
  return payments;
}

/**
 * Today's direct debts as "X owes Y" lines — the default, untouched view that
 * the simplified suggestions are compared against. Largest first; ties by
 * member id so the order never jumps around between loads.
 */
export function listDirectDebts(pairwise: PairwiseBalance[]): SuggestedPayment[] {
  return pairwise
    .filter((p) => p.netAmount !== 0)
    .map((p) =>
      p.netAmount > 0
        ? { fromMemberId: p.memberIdA, toMemberId: p.memberIdB, amount: p.netAmount }
        : { fromMemberId: p.memberIdB, toMemberId: p.memberIdA, amount: -p.netAmount },
    )
    .sort((a, b) => b.amount - a.amount || a.fromMemberId - b.fromMemberId || a.toMemberId - b.toMemberId);
}

/** How many separate direct debts exist today — the "before" in "6 debts → 3 payments". */
export function countDirectDebts(pairwise: PairwiseBalance[]): number {
  return pairwise.filter((p) => p.netAmount !== 0).length;
}
