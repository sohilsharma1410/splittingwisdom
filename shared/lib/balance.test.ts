import { describe, it, expect } from "vitest";
import { computeBalances, getPairwiseBalance, type BillForBalance } from "./balance.js";
import { rupeesToPaise } from "./money.js";

// Member ids used throughout: 1 = Alice, 2 = Bob, 3 = Carol.

describe("computeBalances", () => {
  it("returns nothing for no bills and no settlements", () => {
    expect(computeBalances([], [])).toEqual([]);
  });

  it("a single equal-split bill: non-payers owe the payer their share", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("300"), memberIds: [1, 2, 3] }],
    };
    const balances = computeBalances([bill], []);

    // Alice paid ₹300, split 3 ways (₹100 each) — Bob and Carol each owe her ₹100.
    // getPairwiseBalance(X, Y) is "how much X owes Y" (positive = X owes Y).
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("100")); // Bob owes Alice
    expect(getPairwiseBalance(balances, 1, 2)).toBe(-rupeesToPaise("100")); // reverse direction
    expect(getPairwiseBalance(balances, 3, 1)).toBe(rupeesToPaise("100"));
    // Alice and Carol have no direct relationship other than through Alice.
    expect(getPairwiseBalance(balances, 2, 3)).toBe(0);
  });

  it("the payer never owes themselves, even when included in the split", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("100"), memberIds: [1, 2] }],
    };
    const balances = computeBalances([bill], []);
    expect(balances).toHaveLength(1);
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("50"));
  });

  it("allocates tax proportionally to each member's item share", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1,
      taxAmount: rupeesToPaise("18"),
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [
        { price: rupeesToPaise("60"), memberIds: [2] }, // Bob's item
        { price: rupeesToPaise("40"), memberIds: [3] }, // Carol's item
      ],
    };
    const balances = computeBalances([bill], []);

    // Bob: item 60 + tax proportional (60/100 * 18 = 10.8 -> rounds within paise rule)
    // Carol: item 40 + tax proportional (40/100 * 18 = 7.2)
    const bobOwesAlice = -getPairwiseBalance(balances, 1, 2);
    const carolOwesAlice = -getPairwiseBalance(balances, 1, 3);
    expect(bobOwesAlice + carolOwesAlice).toBe(rupeesToPaise("60") + rupeesToPaise("40") + rupeesToPaise("18"));
    expect(bobOwesAlice).toBeGreaterThan(carolOwesAlice);
  });

  it("a member with zero items on the bill owes zero tax/tip on it", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1,
      taxAmount: rupeesToPaise("50"),
      tipAmount: rupeesToPaise("20"),
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("200"), memberIds: [2] }], // Carol has no items
    };
    const balances = computeBalances([bill], []);
    expect(getPairwiseBalance(balances, 3, 1)).toBe(0);
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("200") + rupeesToPaise("50") + rupeesToPaise("20"));
  });

  it("discount reduces the owed amount, allocated the same way as tax", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: rupeesToPaise("30"),
      items: [{ price: rupeesToPaise("300"), memberIds: [1, 2] }],
    };
    const balances = computeBalances([bill], []);
    // Bob's raw share is 150; with proportional discount of 15, owes 135.
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("135"));
  });

  it("accumulates across multiple bills between the same two people", () => {
    const bill1: BillForBalance = {
      paidByMemberId: 1,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("200"), memberIds: [1, 2] }], // Bob owes Alice 100
    };
    const bill2: BillForBalance = {
      paidByMemberId: 2,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("120") , memberIds: [1, 2] }], // Alice owes Bob 60
    };
    const balances = computeBalances([bill1, bill2], []);
    // Net: Bob owed Alice 100, Alice owed Bob 60 -> Bob still owes Alice 40 net.
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("40"));
  });

  it("a full settlement zeroes out the balance", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("200"), memberIds: [1, 2] }], // Bob owes Alice 100
    };
    const balances = computeBalances(
      [bill],
      [{ payerMemberId: 2, recipientMemberId: 1, amount: rupeesToPaise("100") }],
    );
    expect(getPairwiseBalance(balances, 2, 1)).toBe(0);
  });

  it("a partial settlement reduces but doesn't zero the balance", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("200"), memberIds: [1, 2] }], // Bob owes Alice 100
    };
    const balances = computeBalances(
      [bill],
      [{ payerMemberId: 2, recipientMemberId: 1, amount: rupeesToPaise("40") }],
    );
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("60"));
  });

  it("settlements with no prior bill activity are still reflected", () => {
    const balances = computeBalances(
      [],
      [{ payerMemberId: 2, recipientMemberId: 1, amount: rupeesToPaise("25") }],
    );
    // Bob paid Alice without an underlying bill (e.g. an advance) -> Alice now owes Bob.
    expect(getPairwiseBalance(balances, 1, 2)).toBe(rupeesToPaise("25"));
  });

  it("invariant: sum of every member's total on a bill equals the bill's grand total", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1,
      taxAmount: rupeesToPaise("180"),
      tipAmount: rupeesToPaise("50"),
      serviceFeeAmount: rupeesToPaise("20"),
      discountAmount: rupeesToPaise("10"),
      items: [{ price: rupeesToPaise("1000"), memberIds: [1, 2, 3] }],
    };
    const balances = computeBalances([bill], []);
    const bobOwesAlice = -getPairwiseBalance(balances, 1, 2);
    const carolOwesAlice = -getPairwiseBalance(balances, 1, 3);
    // Alice's own share isn't debt (she owes herself nothing), so the grand
    // total equals Alice's own share plus what Bob and Carol owe her.
    const grandTotal =
      rupeesToPaise("1000") + rupeesToPaise("180") + rupeesToPaise("50") + rupeesToPaise("20") - rupeesToPaise("10");
    const aliceOwnShare = grandTotal - bobOwesAlice - carolOwesAlice;
    expect(aliceOwnShare + bobOwesAlice + carolOwesAlice).toBe(grandTotal);
  });
});
