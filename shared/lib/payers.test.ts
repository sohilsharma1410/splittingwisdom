import { describe, expect, it } from "vitest";
import {
  computeBalances,
  computeBillBreakdown,
  computeBillDebts,
  getPairwiseBalance,
  summarizeMember,
  type BillForSummary,
  type BillItemForBalance,
  type BillPayer,
} from "./balance.js";
import { computeBillSettlementStatuses } from "./settlement.js";
import { mainPayer, payersProblem } from "../schema.js";

// Member ids: 1 = Asha, 2 = Bala, 3 = Chitra, 4 = Dev.
const equal = (ids: number[]) => ids.map((memberId) => ({ memberId, splitType: "equal" as const }));
const charges = { taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0 };
const one = (memberId: number, price: number): BillItemForBalance => ({ price, assignments: equal([memberId]) });
function bill(payers: BillPayer[], items: BillItemForBalance[], extra: Partial<BillForSummary> = {}): BillForSummary {
  const grandTotal = payers.reduce((sum, p) => sum + p.amount, 0);
  return { ...charges, paidByMemberId: mainPayer(payers), payers, items, grandTotal, ...extra };
}
const nets = (b: BillForSummary, ids: number[]) => ids.map((id) => summarizeMember([b], [], id).net);

describe("a bill several people paid", () => {
  it("creates no debts when everyone paid exactly their own share (each bought their own ticket)", () => {
    const flights = bill(
      [{ memberId: 1, amount: 512300 }, { memberId: 2, amount: 498700 }, { memberId: 3, amount: 501001 }],
      [one(1, 512300), one(2, 498700), one(3, 501001)],
    );
    expect(computeBillDebts(flights)).toEqual([]);
    expect(computeBalances([flights], [])).toEqual([]);
    expect([1, 2, 3].map((id) => summarizeMember([flights], [], id))).toMatchObject([
      { paid: 512300, share: 512300, net: 0 },
      { paid: 498700, share: 498700, net: 0 },
      { paid: 501001, share: 501001, net: 0 },
    ]);
    expect(summarizeMember([flights], [], 1).groupSpent).toBe(1512001);
  });

  it("has those who paid less than their share pay those who paid more, and nothing more", () => {
    // Asha paid 600 and Bala 400; shares are Asha 500, Bala 300, Chitra 200.
    const dinner = bill([{ memberId: 1, amount: 60000 }, { memberId: 2, amount: 40000 }], [one(1, 50000), one(2, 30000), one(3, 20000)]);
    expect(computeBillDebts(dinner)).toEqual([
      { debtorId: 3, creditorId: 1, amount: 10000 },
      { debtorId: 3, creditorId: 2, amount: 10000 },
    ]);
    expect(nets(dinner, [1, 2, 3])).toEqual([10000, 10000, -20000]);
  });

  it("shares what nobody had among the payers, in proportion to what they paid", () => {
    // ₹1,000 bill, ₹200 of it assigned to nobody. Asha paid 750, Bala 250.
    const b = bill([{ memberId: 1, amount: 75000 }, { memberId: 2, amount: 25000 }], [one(3, 80000), { price: 20000, assignments: [] }]);
    // Credit for the ₹800 assigned: Asha 600, Bala 200, all owed by Chitra.
    expect(computeBillDebts(b)).toEqual([
      { debtorId: 3, creditorId: 1, amount: 60000 },
      { debtorId: 3, creditorId: 2, amount: 20000 },
    ]);
    expect(summarizeMember([b], [], 1)).toMatchObject({ paid: 75000, share: 0, unassigned: 20000, net: 60000 });
  });

  it("keeps every paisa when the amounts don't divide evenly", () => {
    // ₹1.00 paid 1/1/98 paise-wise by three people, eaten by four.
    const b = bill([{ memberId: 1, amount: 33 }, { memberId: 2, amount: 33 }, { memberId: 3, amount: 34 }], [{ price: 100, assignments: equal([1, 2, 3, 4]) }]);
    const debts = computeBillDebts(b);
    expect(debts.every((d) => Number.isInteger(d.amount) && d.amount > 0)).toBe(true);
    const n = nets(b, [1, 2, 3, 4]);
    expect(n.reduce((a, c) => a + c, 0)).toBe(0);
    // Shares are 25 each (equal split of 100), so each net is paid - 25 exactly.
    expect(n).toEqual([8, 8, 9, -25]);
  });

  it("treats one payer listed as the whole bill exactly like a bill with no payer list", () => {
    const items = [{ price: 30001, assignments: equal([1, 2, 3]) }];
    const listed = computeBillDebts({ ...charges, paidByMemberId: 1, payers: [{ memberId: 1, amount: 30001 }], items });
    const plain = computeBillDebts({ ...charges, paidByMemberId: 1, payers: null, items });
    expect(listed).toEqual(plain);
  });

  it("marks the bill settled only once everyone who owes has paid each payer", () => {
    const dinner = { ...bill([{ memberId: 1, amount: 60000 }, { memberId: 2, amount: 40000 }], [one(1, 50000), one(2, 30000), one(3, 20000)]), id: 7, sortKey: 1 };
    const statusAfter = (settlements: { payerMemberId: number; recipientMemberId: number; amount: number }[]) =>
      computeBillSettlementStatuses([dinner], settlements).get(7);
    expect(statusAfter([])).toBe("pending");
    expect(statusAfter([{ payerMemberId: 3, recipientMemberId: 1, amount: 10000 }])).toBe("pending");
    expect(statusAfter([{ payerMemberId: 3, recipientMemberId: 1, amount: 10000 }, { payerMemberId: 3, recipientMemberId: 2, amount: 10000 }])).toBe("settled");
  });
});

describe("property: several payers, random bills", () => {
  function rng(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  it("debts match each person's credit minus share exactly, nets add to zero, and net = paid - share when all is assigned", () => {
    const rand = rng(7);
    const pool = [1, 2, 3, 4, 5, 6];
    for (let trial = 0; trial < 500; trial++) {
      const items: BillItemForBalance[] = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({
        price: 1 + Math.floor(rand() * 2_000_000),
        assignments: equal([...pool].sort(() => rand() - 0.5).slice(0, 1 + Math.floor(rand() * pool.length))),
      }));
      const tax = Math.floor(rand() * 50_000);
      const discount = Math.floor(rand() * 10_000);
      const subtotal = items.reduce((sum, i) => sum + i.price, 0);
      const grandTotal = subtotal + tax - discount;
      // Split the grand total among 2-4 random payers.
      const payerIds = [...pool].sort(() => rand() - 0.5).slice(0, 2 + Math.floor(rand() * 3));
      const cuts = payerIds.slice(1).map(() => 1 + Math.floor(rand() * (grandTotal - payerIds.length))).sort((a, b) => a - b);
      const bounds = [0, ...cuts, grandTotal];
      const payers = payerIds.map((memberId, i) => ({ memberId, amount: bounds[i + 1] - bounds[i] })).filter((p) => p.amount > 0);
      if (payers.length < 2) continue;
      const b: BillForSummary = { ...charges, taxAmount: tax, discountAmount: discount, paidByMemberId: mainPayer(payers), payers, items, grandTotal };

      const shares = new Map(computeBillBreakdown(b).map((r) => [r.memberId, r.total]));
      const pairwise = computeBalances([b], []);
      let sum = 0;
      for (const id of pool) {
        const fromLedger = pool.reduce((acc, other) => (other === id ? acc : acc + getPairwiseBalance(pairwise, other, id)), 0);
        const summary = summarizeMember([b], [], id);
        expect(summary.net).toBe(fromLedger);
        expect(summary.net).toBe(summary.paid - (shares.get(id) ?? 0)); // every item is assigned here
        sum += summary.net;
      }
      expect(sum).toBe(0);
      for (const d of computeBillDebts(b)) expect(Number.isInteger(d.amount) && d.amount > 0 && d.debtorId !== d.creditorId).toBe(true);
    }
  });
});

describe("checking a list of payers", () => {
  it("must add up to the bill's total exactly", () => {
    expect(payersProblem(null, 100)).toBeNull();
    expect(payersProblem([{ memberId: 1, amount: 60 }, { memberId: 2, amount: 40 }], 100)).toBeNull();
    expect(payersProblem([{ memberId: 1, amount: 60 }, { memberId: 2, amount: 39 }], 100)).toMatch(/₹0.01 short/);
    expect(payersProblem([{ memberId: 1, amount: 60 }, { memberId: 2, amount: 41 }], 100)).toMatch(/₹0.01 more/);
  });
  it("shows whoever paid most as the main payer, the lower id on a tie", () => {
    expect(mainPayer([{ memberId: 3, amount: 10 }, { memberId: 2, amount: 50 }])).toBe(2);
    expect(mainPayer([{ memberId: 3, amount: 50 }, { memberId: 2, amount: 50 }])).toBe(2);
  });
});
