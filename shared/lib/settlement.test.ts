import { describe, it, expect } from "vitest";
import { computeBalances, type BillForBalance, type SettlementForBalance } from "./balance.js";
import {
  allocateAcrossGroups,
  checkSettlement,
  computeBillSettlementStatuses,
  countDirectDebts,
  directDebt,
  listDirectDebts,
  maxSettlementAmount,
  netPositions,
  routeThroughDebts,
  simplifyDebts,
  type BillForStatus,
} from "./settlement.js";
import { rupeesToPaise } from "./money.js";

const A = 1, B = 2, C = 3, D = 4, E = 5;

function bill(paidBy: number, price: number, memberIds: number[]): BillForBalance {
  return {
    paidByMemberId: paidBy,
    taxAmount: 0,
    tipAmount: 0,
    serviceFeeAmount: 0,
    discountAmount: 0,
    items: [{ price, assignments: memberIds.map((memberId) => ({ memberId, splitType: "equal" as const })) }],
  };
}
const settle = (payer: number, recipient: number, amount: number): SettlementForBalance => ({
  payerMemberId: payer,
  recipientMemberId: recipient,
  amount,
});
const rs = rupeesToPaise;

describe("netPositions / directDebt", () => {
  it("sums to zero across the group and signs creditors positive", () => {
    const pairwise = computeBalances([bill(A, rs("300"), [A, B, C])], []);
    const net = netPositions(pairwise);
    expect(net.get(A)).toBe(rs("200"));
    expect(net.get(B)).toBe(-rs("100"));
    expect(net.get(C)).toBe(-rs("100"));
    expect([...net.values()].reduce((s, v) => s + v, 0)).toBe(0);
  });
  it("directDebt is one-directional and never negative", () => {
    const pairwise = computeBalances([bill(A, rs("200"), [A, B])], []);
    expect(directDebt(pairwise, B, A)).toBe(rs("100"));
    expect(directDebt(pairwise, A, B)).toBe(0);
  });
});

describe("checkSettlement — the overpayment cap", () => {
  const pairwise = computeBalances([bill(A, rs("300"), [A, B, C])], []); // B and C each owe A ₹100

  it("allows paying exactly what's owed and anything below it", () => {
    expect(checkSettlement(pairwise, B, A, rs("100")).ok).toBe(true);
    expect(checkSettlement(pairwise, B, A, 1).ok).toBe(true);
  });
  it("rejects one paisa more than is owed, naming the maximum", () => {
    const r = checkSettlement(pairwise, B, A, rs("100") + 1);
    expect(r).toMatchObject({ ok: false, reason: "exceeds", max: rs("100") });
    expect(r.ok === false && r.message).toContain("₹100.00");
  });
  it("rejects zero, negative, fractional and same-person amounts", () => {
    expect(checkSettlement(pairwise, B, A, 0)).toMatchObject({ ok: false, reason: "invalid-amount" });
    expect(checkSettlement(pairwise, B, A, -5)).toMatchObject({ ok: false, reason: "invalid-amount" });
    expect(checkSettlement(pairwise, B, A, 10.5)).toMatchObject({ ok: false, reason: "invalid-amount" });
    expect(checkSettlement(pairwise, B, B, 100)).toMatchObject({ ok: false, reason: "same-person" });
  });
  it("rejects paying someone who owes you, or a stranger to the debt", () => {
    expect(checkSettlement(pairwise, A, B, 100)).toMatchObject({ ok: false, reason: "nothing-owed" });
    expect(checkSettlement(pairwise, B, C, 100)).toMatchObject({ ok: false, reason: "nothing-owed" });
  });
  it("₹5,000 against an ₹800 balance is rejected even though 5000 is a valid number", () => {
    const owed = computeBalances([bill(A, rs("1600"), [A, B])], []); // B owes ₹800
    expect(directDebt(owed, B, A)).toBe(rs("800"));
    expect(checkSettlement(owed, B, A, rs("5000"))).toMatchObject({ ok: false, reason: "exceeds", max: rs("800") });
  });
  it("partial then full: ₹500 of ₹1,300 leaves ₹800, then paying ₹800 settles the pair", () => {
    const bills = [bill(A, rs("2600"), [A, B])]; // B owes ₹1,300
    let pw = computeBalances(bills, []);
    expect(maxSettlementAmount(pw, B, A)).toBe(rs("1300"));
    pw = computeBalances(bills, [settle(B, A, rs("500"))]);
    expect(maxSettlementAmount(pw, B, A)).toBe(rs("800"));
    expect(checkSettlement(pw, B, A, rs("800")).ok).toBe(true);
    pw = computeBalances(bills, [settle(B, A, rs("500")), settle(B, A, rs("800"))]);
    expect(maxSettlementAmount(pw, B, A)).toBe(0);
    expect(checkSettlement(pw, B, A, 1)).toMatchObject({ ok: false, reason: "nothing-owed" });
  });
  it("a settlement followed by a new bill re-accumulates", () => {
    const bills = [bill(A, rs("200"), [A, B])];
    const afterFull = computeBalances(bills, [settle(B, A, rs("100"))]);
    expect(maxSettlementAmount(afterFull, B, A)).toBe(0);
    const later = computeBalances([...bills, bill(A, rs("60"), [A, B])], [settle(B, A, rs("100"))]);
    expect(maxSettlementAmount(later, B, A)).toBe(rs("30"));
  });
  it("allows a payment that settles net positions even without a direct debt (A owes B, B owes C → A pays C)", () => {
    const chain = computeBalances([bill(B, rs("200"), [A, B]), bill(C, rs("200"), [B, C])], []); // A→B 100, B→C 100
    expect(directDebt(chain, A, C)).toBe(0);
    expect(maxSettlementAmount(chain, A, C)).toBe(rs("100"));
    expect(checkSettlement(chain, A, C, rs("100")).ok).toBe(true);
    expect(checkSettlement(chain, A, C, rs("100") + 1)).toMatchObject({ ok: false, reason: "exceeds" });
  });
  it("a direct debt can be paid in full even when the payer is owed more elsewhere", () => {
    // B owes A ₹100 directly but is owed ₹400 by C, so B's net position is positive.
    const pw = computeBalances([bill(A, rs("200"), [A, B]), bill(B, rs("800"), [B, C])], []);
    expect(directDebt(pw, B, A)).toBe(rs("100"));
    expect(checkSettlement(pw, B, A, rs("100")).ok).toBe(true);
  });
});

describe("allocateAcrossGroups — settling with someone you share several groups with", () => {
  const lines = [
    { groupId: 3, payerMemberId: 31, recipientMemberId: 32, owed: 100 },
    { groupId: 1, payerMemberId: 11, recipientMemberId: 12, owed: 50 },
    { groupId: 2, payerMemberId: 21, recipientMemberId: 22, owed: 0 },
  ];
  it("fills the lowest group id first and skips groups with nothing owed", () => {
    const { allocations, remainder } = allocateAcrossGroups(lines, 120);
    expect(allocations.map((a) => [a.groupId, a.amount])).toEqual([[1, 50], [3, 70]]);
    expect(remainder).toBe(0);
  });
  it("never allocates more than owed and reports what didn't fit", () => {
    const { allocations, remainder } = allocateAcrossGroups(lines, 200);
    expect(allocations.reduce((s, a) => s + a.amount, 0)).toBe(150);
    expect(remainder).toBe(50);
  });
  it("allocated amounts always sum to the request when it fits (no paisa lost)", () => {
    for (const amount of [1, 49, 50, 51, 99, 149, 150]) {
      const { allocations, remainder } = allocateAcrossGroups(lines, amount);
      expect(allocations.reduce((s, a) => s + a.amount, 0) + remainder).toBe(amount);
    }
  });
  it("is independent of input order", () => {
    expect(allocateAcrossGroups([...lines].reverse(), 120)).toEqual(allocateAcrossGroups(lines, 120));
  });
});

describe("computeBillSettlementStatuses — Settled/Pending is derived", () => {
  const withKeys = (bills: BillForBalance[]): BillForStatus[] => bills.map((b, i) => ({ ...b, id: i + 1, sortKey: i }));

  it("everything is pending until money moves, then settled bill by bill, oldest first", () => {
    const bills = withKeys([bill(A, rs("200"), [A, B]), bill(A, rs("200"), [A, B])]); // B owes ₹100 on each
    expect([...computeBillSettlementStatuses(bills, [])]).toEqual([[1, "pending"], [2, "pending"]]);
    expect(computeBillSettlementStatuses(bills, [settle(B, A, rs("100"))]).get(1)).toBe("settled");
    expect(computeBillSettlementStatuses(bills, [settle(B, A, rs("100"))]).get(2)).toBe("pending");
    expect(computeBillSettlementStatuses(bills, [settle(B, A, rs("50"))]).get(1)).toBe("pending");
    const all = computeBillSettlementStatuses(bills, [settle(B, A, rs("100")), settle(B, A, rs("100"))]);
    expect([...all.values()]).toEqual(["settled", "settled"]);
  });
  it("applies payments oldest-first regardless of array order", () => {
    const bills = withKeys([bill(A, rs("200"), [A, B]), bill(A, rs("200"), [A, B])]).reverse();
    const s = computeBillSettlementStatuses(bills, [settle(B, A, rs("100"))]);
    expect(s.get(1)).toBe("settled");
    expect(s.get(2)).toBe("pending");
  });
  it("opposite debts cancel: both bills settle with no payment at all", () => {
    const bills = withKeys([bill(A, rs("200"), [A, B]), bill(B, rs("200"), [A, B])]);
    expect([...computeBillSettlementStatuses(bills, []).values()]).toEqual(["settled", "settled"]);
  });
  it("unequal opposite debts: the smaller one settles, the larger stays pending until paid down", () => {
    const bills = withKeys([bill(A, rs("200"), [A, B]), bill(B, rs("120"), [A, B])]); // B owes 100, A owes 60
    const before = computeBillSettlementStatuses(bills, []);
    expect(before.get(1)).toBe("pending");
    expect(before.get(2)).toBe("settled");
    expect(computeBillSettlementStatuses(bills, [settle(B, A, rs("40"))]).get(1)).toBe("settled");
  });
  it("a bill that created no debt (only the payer was on it) is settled", () => {
    expect(computeBillSettlementStatuses(withKeys([bill(A, rs("100"), [A])]), []).get(1)).toBe("settled");
  });
  it("a bill is pending if ANY participant still owes", () => {
    const bills = withKeys([bill(A, rs("300"), [A, B, C])]);
    const s = computeBillSettlementStatuses(bills, [settle(B, A, rs("100"))]);
    expect(s.get(1)).toBe("pending"); // Carol hasn't paid
    expect(computeBillSettlementStatuses(bills, [settle(B, A, rs("100")), settle(C, A, rs("100"))]).get(1)).toBe("settled");
  });
});

describe("simplifyDebts", () => {
  it("a 3-person cycle resolves in strictly fewer payments (here: none)", () => {
    const pw = computeBalances([bill(B, rs("200"), [A, B]), bill(C, rs("200"), [B, C]), bill(A, rs("200"), [C, A])], []);
    expect(countDirectDebts(pw)).toBe(3);
    expect(simplifyDebts(pw)).toEqual([]);
  });
  it("a chain A→B→C collapses to one payment A→C for the same money", () => {
    const pw = computeBalances([bill(B, rs("200"), [A, B]), bill(C, rs("200"), [B, C])], []);
    expect(countDirectDebts(pw)).toBe(2);
    expect(simplifyDebts(pw)).toEqual([{ fromMemberId: A, toMemberId: C, amount: rs("100") }]);
  });
  it("a group already at the minimum is unchanged", () => {
    const pw = computeBalances([bill(B, rs("100"), [A, B])], []);
    expect(simplifyDebts(pw)).toEqual([{ fromMemberId: A, toMemberId: B, amount: rs("50") }]);
  });
  it("zero or empty balances produce no suggestions", () => {
    expect(simplifyDebts([])).toEqual([]);
    const settled = computeBalances([bill(A, rs("200"), [A, B])], [settle(B, A, rs("100"))]);
    expect(simplifyDebts(settled)).toEqual([]);
  });
  it("breaks ties by lowest member id so results are reproducible", () => {
    const pw = computeBalances([bill(A, rs("300"), [A, B, C])], []); // B and C each owe A ₹100
    expect(simplifyDebts(pw)).toEqual([
      { fromMemberId: B, toMemberId: A, amount: rs("100") },
      { fromMemberId: C, toMemberId: A, amount: rs("100") },
    ]);
  });
  it("suggestions are order-independent", () => {
    const bills = [bill(A, rs("600"), [A, B, C, D]), bill(C, rs("90"), [B, C, D]), bill(D, rs("45"), [A, D])];
    expect(simplifyDebts(computeBalances(bills, []))).toEqual(simplifyDebts(computeBalances([...bills].reverse(), [])));
  });

  it("property: the first suggestion can always be paid as a chain; repeating that zeroes everyone and never needs more payments than debts (300 random groups)", () => {
    let seed = 20260101;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const members = [A, B, C, D, E];
    for (let trial = 0; trial < 300; trial++) {
      const bills: BillForBalance[] = [];
      for (let i = 0, n = 1 + Math.floor(rand() * 6); i < n; i++) {
        const participants = members.filter(() => rand() < 0.6);
        if (participants.length === 0) continue;
        const payer = members[Math.floor(rand() * members.length)];
        bills.push(bill(payer, 100 + Math.floor(rand() * 90000), participants));
      }
      const pw = computeBalances(bills, []);
      const suggestions = simplifyDebts(pw);

      const net = netPositions(pw);
      const owedTotal = [...net.values()].filter((v) => v > 0).reduce((s, v) => s + v, 0);
      expect(suggestions.reduce((s, p) => s + p.amount, 0)).toBe(owedTotal);
      expect(suggestions.length).toBeLessThanOrEqual(countDirectDebts(pw));
      for (const p of suggestions) expect(p.amount).toBeGreaterThan(0);

      // Pay suggestions the way the app does: take what's suggested NOW, pay it as a chain along
      // real debts, then look again (paying one can change the others, so they're recomputed).
      let applied: SettlementForBalance[] = [];
      for (let step = 0; ; step++) {
        const now = computeBalances(bills, applied);
        const [p] = simplifyDebts(now);
        if (!p) break;
        expect(step, `trial ${trial} did not converge`).toBeLessThan(40);
        expect(checkSettlement(now, p.fromMemberId, p.toMemberId, p.amount).ok).toBe(true);
        const hops = routeThroughDebts(now, p.fromMemberId, p.toMemberId, p.amount);
        expect(hops, `trial ${trial}: ${JSON.stringify(p)}`).not.toBeNull();
        // Every hop is a debt that really exists, paid down — never more than owed.
        for (const h of hops!) expect(h.amount).toBeLessThanOrEqual(directDebt(now, h.fromMemberId, h.toMemberId));
        applied = [...applied, ...hops!.map((h) => settle(h.fromMemberId, h.toMemberId, h.amount))];
      }
      const after = computeBalances(bills, applied);
      expect([...netPositions(after).values()].every((v) => v === 0)).toBe(true);
      // Whatever debts are left must be pure loops (cancelling each other), nothing one-sided.
      const owes = new Map<number, number>(), owed = new Map<number, number>();
      for (const d of listDirectDebts(after)) {
        owes.set(d.fromMemberId, (owes.get(d.fromMemberId) ?? 0) + d.amount);
        owed.set(d.toMemberId, (owed.get(d.toMemberId) ?? 0) + d.amount);
      }
      for (const id of members) expect(owes.get(id) ?? 0).toBe(owed.get(id) ?? 0);
    }
  });
});

describe("routeThroughDebts — paying a suggestion as the chain it stands for", () => {
  const chain = computeBalances(
    [bill(B, rs("200"), [A, B]), bill(C, rs("200"), [B, C]), bill(D, rs("200"), [C, D])],
    [],
  ); // Ann→Bob 100, Bob→Cat 100, Cat→Dan 100

  it("turns 'Ann pays Dan ₹100' into one settlement per real debt, leaving nothing behind", () => {
    const hops = routeThroughDebts(chain, A, D, rs("100"))!;
    expect(hops).toEqual([
      { fromMemberId: A, toMemberId: B, amount: rs("100") },
      { fromMemberId: B, toMemberId: C, amount: rs("100") },
      { fromMemberId: C, toMemberId: D, amount: rs("100") },
    ]);
    const after = computeBalances(
      [bill(B, rs("200"), [A, B]), bill(C, rs("200"), [B, C]), bill(D, rs("200"), [C, D])],
      hops.map((h) => settle(h.fromMemberId, h.toMemberId, h.amount)),
    );
    expect(listDirectDebts(after)).toEqual([]); // the Direct view is clean too
  });
  it("a partial payment pays every hop down by the same amount", () => {
    const hops = routeThroughDebts(chain, A, D, rs("40"))!;
    expect(hops.map((h) => h.amount)).toEqual([rs("40"), rs("40"), rs("40")]);
  });
  it("uses a direct debt as a one-hop route", () => {
    expect(routeThroughDebts(chain, A, B, rs("100"))).toEqual([{ fromMemberId: A, toMemberId: B, amount: rs("100") }]);
  });
  it("returns null when the debts can't carry that much that way", () => {
    expect(routeThroughDebts(chain, A, D, rs("100") + 1)).toBeNull();
    expect(routeThroughDebts(chain, D, A, rs("1"))).toBeNull();
    expect(routeThroughDebts(chain, A, A, 1)).toBeNull();
    expect(routeThroughDebts(chain, A, D, 0)).toBeNull();
  });
  it("splits across two routes when one isn't enough", () => {
    // Ann owes Bob 100 and Cat 100; Bob and Cat each owe Dan 100: Ann→Dan 200 needs both routes.
    const pw = computeBalances([bill(B, rs("200"), [A, B]), bill(C, rs("200"), [A, C]), bill(D, rs("200"), [B, D]), bill(D, rs("200"), [C, D])], []);
    const hops = routeThroughDebts(pw, A, D, rs("200"))!;
    expect(hops.reduce((s, h) => s + h.amount, 0)).toBe(rs("400")); // 2 hops x 2 routes
    expect(hops.every((h) => h.amount === rs("100"))).toBe(true);
  });
});

describe("listDirectDebts", () => {
  it("lists each open pair once, as debtor → creditor, largest first", () => {
    const pw = computeBalances([bill(A, rs("300"), [A, B, C]), bill(B, rs("100"), [B, C])], []);
    // B owes A 100, C owes A 100, C owes B 50
    expect(listDirectDebts(pw)).toEqual([
      { fromMemberId: B, toMemberId: A, amount: rs("100") },
      { fromMemberId: C, toMemberId: A, amount: rs("100") },
      { fromMemberId: C, toMemberId: B, amount: rs("50") },
    ]);
    expect(countDirectDebts(pw)).toBe(3);
  });
  it("omits settled pairs and is empty when nothing is owed", () => {
    expect(listDirectDebts([])).toEqual([]);
    expect(listDirectDebts(computeBalances([bill(A, rs("200"), [A, B])], [settle(B, A, rs("100"))]))).toEqual([]);
  });
  it("direct debts and simplified payments move the same net money", () => {
    const pw = computeBalances([bill(B, rs("200"), [A, B]), bill(C, rs("200"), [B, C])], []);
    expect(listDirectDebts(pw)).toHaveLength(2);
    expect(simplifyDebts(pw)).toHaveLength(1);
  });
});
