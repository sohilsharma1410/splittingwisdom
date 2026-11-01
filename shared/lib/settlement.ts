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

// A debt graph: graph.get(debtor)?.get(creditor) = paise the debtor owes the creditor.
type DebtGraph = Map<number, Map<number, number>>;

function debtGraph(pairwise: PairwiseBalance[]): DebtGraph {
  const graph: DebtGraph = new Map();
  const add = (debtor: number, creditor: number, amount: number) => {
    if (!graph.has(debtor)) graph.set(debtor, new Map());
    graph.get(debtor)!.set(creditor, amount);
  };
  for (const { memberIdA, memberIdB, netAmount } of pairwise) {
    if (netAmount > 0) add(memberIdA, memberIdB, netAmount);
    else if (netAmount < 0) add(memberIdB, memberIdA, -netAmount);
  }
  return graph;
}

/** Fewest-hops path from `from` to the best `isTarget` node, over edges with debt left. Deterministic (lowest ids first). */
function findDebtPath(
  graph: DebtGraph,
  from: number,
  pickTarget: (reachable: number[]) => number | null,
): number[] | null {
  const parent = new Map<number, number>([[from, from]]);
  const order: number[] = [];
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const next = [...(graph.get(node) ?? [])].filter(([, cap]) => cap > 0).map(([to]) => to).sort((x, y) => x - y);
    for (const to of next) {
      if (parent.has(to)) continue;
      parent.set(to, node);
      order.push(to);
      queue.push(to);
    }
  }
  const target = pickTarget(order);
  if (target === null) return null;
  const path = [target];
  while (path[0] !== from) path.unshift(parent.get(path[0])!);
  return path;
}

/**
 * Pays `amount` from `from` to `to` THROUGH the debts that actually exist,
 * as a set of ordinary settlements — one per debt that gets paid down. If Ann
 * owes Bob, Bob owes Cat and Cat owes Dan (₹100 each), "Ann pays Dan ₹100"
 * becomes Ann→Bob, Bob→Cat and Cat→Dan (₹100 each): every hop is a real debt
 * being cleared, so afterwards nothing odd is left behind. Returns null when
 * the debts can't carry that much from `from` to `to`.
 */
export function routeThroughDebts(
  pairwise: PairwiseBalance[],
  from: number,
  to: number,
  amount: number,
): SuggestedPayment[] | null {
  if (from === to || amount <= 0) return null;
  const original = debtGraph(pairwise);
  // Residual capacities (Edmonds–Karp): pushing along u→v also opens v→u, so a
  // later path can undo part of an earlier one rather than being blocked by it.
  const residual: DebtGraph = new Map();
  const ensure = (u: number, v: number) => {
    if (!residual.has(u)) residual.set(u, new Map());
    if (!residual.get(u)!.has(v)) residual.get(u)!.set(v, 0);
  };
  for (const [u, edges] of original) for (const [v, cap] of edges) { ensure(u, v); ensure(v, u); residual.get(u)!.set(v, cap); }

  let remaining = amount;
  while (remaining > 0) {
    const path = findDebtPath(residual, from, (reachable) => (reachable.includes(to) ? to : null));
    if (!path) return null;
    let push = remaining;
    for (let i = 0; i + 1 < path.length; i++) push = Math.min(push, residual.get(path[i])!.get(path[i + 1])!);
    for (let i = 0; i + 1 < path.length; i++) {
      const u = path[i], v = path[i + 1];
      residual.get(u)!.set(v, residual.get(u)!.get(v)! - push);
      residual.get(v)!.set(u, residual.get(v)!.get(u)! + push);
    }
    remaining -= push;
  }

  const edges: SuggestedPayment[] = [];
  for (const [u, outgoing] of original) {
    for (const [v, cap] of outgoing) {
      const flow = cap - residual.get(u)!.get(v)!;
      if (flow > 0) edges.push({ fromMemberId: u, toMemberId: v, amount: flow });
    }
  }
  return edges.sort((a, b) => a.fromMemberId - b.fromMemberId || a.toMemberId - b.toMemberId);
}

/**
 * The payments that would settle everyone's net position, found as paths
 * through the debts that exist (so each one can be paid as a chain — see
 * routeThroughDebts). Never more than the number of direct debts. Ties go to
 * the lowest member id, so the same balances always give the same suggestions.
 */
export function simplifyDebts(pairwise: PairwiseBalance[]): SuggestedPayment[] {
  const graph = debtGraph(pairwise);
  const net = netPositions(pairwise);
  const deficit = new Map([...net].filter(([, v]) => v < 0).map(([id, v]) => [id, -v]));
  const credit = new Map([...net].filter(([, v]) => v > 0));
  const paid = new Map<string, number>();

  while (true) {
    const debtors = [...deficit].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (debtors.length === 0) break;
    const [debtor, owes] = debtors[0];
    const path = findDebtPath(graph, debtor, (reachable) => {
      const options = reachable.filter((id) => (credit.get(id) ?? 0) > 0).sort((a, b) => credit.get(b)! - credit.get(a)! || a - b);
      return options[0] ?? null;
    });
    if (!path) break; // can't happen while net positions are consistent; never loop forever
    const creditor = path[path.length - 1];
    let push = Math.min(owes, credit.get(creditor)!);
    for (let i = 0; i + 1 < path.length; i++) push = Math.min(push, graph.get(path[i])!.get(path[i + 1])!);
    for (let i = 0; i + 1 < path.length; i++) graph.get(path[i])!.set(path[i + 1], graph.get(path[i])!.get(path[i + 1])! - push);
    deficit.set(debtor, owes - push);
    credit.set(creditor, credit.get(creditor)! - push);
    const key = `${debtor}>${creditor}`;
    paid.set(key, (paid.get(key) ?? 0) + push);
  }

  return [...paid]
    .map(([key, amount]) => {
      const [fromMemberId, toMemberId] = key.split(">").map(Number);
      return { fromMemberId, toMemberId, amount };
    })
    .sort((a, b) => b.amount - a.amount || a.fromMemberId - b.fromMemberId || a.toMemberId - b.toMemberId);
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
