import { describe, it, expect } from "vitest";
import {
  computeBalances,
  computeItemShares,
  getPairwiseBalance,
  summarizeMember,
  type BillForSummary,
  type BillForBalance,
  type BillItemForBalance,
} from "./balance.js";
import { rupeesToPaise } from "./money.js";

// Member ids used throughout: 1 = Alice, 2 = Bob, 3 = Carol.

/** Equal-split assignment list — the common case in most tests below. */
function equalAssignments(memberIds: number[]) {
  return memberIds.map((memberId) => ({ memberId, splitType: "equal" as const }));
}

describe("computeBalances", () => {
  it("returns nothing for no bills and no settlements", () => {
    expect(computeBalances([], [])).toEqual([]);
  });

  it("a single equal-split bill: non-payers owe the payer their share", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1, payers: null,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("300"), assignments: equalAssignments([1, 2, 3]) }],
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
      paidByMemberId: 1, payers: null,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("100"), assignments: equalAssignments([1, 2]) }],
    };
    const balances = computeBalances([bill], []);
    expect(balances).toHaveLength(1);
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("50"));
  });

  it("allocates tax proportionally to each member's item share", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1, payers: null,
      taxAmount: rupeesToPaise("18"),
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [
        { price: rupeesToPaise("60"), assignments: equalAssignments([2]) }, // Bob's item
        { price: rupeesToPaise("40"), assignments: equalAssignments([3]) }, // Carol's item
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
      paidByMemberId: 1, payers: null,
      taxAmount: rupeesToPaise("50"),
      tipAmount: rupeesToPaise("20"),
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("200"), assignments: equalAssignments([2]) }], // Carol has no items
    };
    const balances = computeBalances([bill], []);
    expect(getPairwiseBalance(balances, 3, 1)).toBe(0);
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("200") + rupeesToPaise("50") + rupeesToPaise("20"));
  });

  it("discount reduces the owed amount, allocated the same way as tax", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1, payers: null,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: rupeesToPaise("30"),
      items: [{ price: rupeesToPaise("300"), assignments: equalAssignments([1, 2]) }],
    };
    const balances = computeBalances([bill], []);
    // Bob's raw share is 150; with proportional discount of 15, owes 135.
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("135"));
  });

  it("accumulates across multiple bills between the same two people", () => {
    const bill1: BillForBalance = {
      paidByMemberId: 1, payers: null,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("200"), assignments: equalAssignments([1, 2]) }], // Bob owes Alice 100
    };
    const bill2: BillForBalance = {
      paidByMemberId: 2, payers: null,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("120"), assignments: equalAssignments([1, 2]) }], // Alice owes Bob 60
    };
    const balances = computeBalances([bill1, bill2], []);
    // Net: Bob owed Alice 100, Alice owed Bob 60 -> Bob still owes Alice 40 net.
    expect(getPairwiseBalance(balances, 2, 1)).toBe(rupeesToPaise("40"));
  });

  it("a full settlement zeroes out the balance", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1, payers: null,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("200"), assignments: equalAssignments([1, 2]) }], // Bob owes Alice 100
    };
    const balances = computeBalances(
      [bill],
      [{ payerMemberId: 2, recipientMemberId: 1, amount: rupeesToPaise("100") }],
    );
    expect(getPairwiseBalance(balances, 2, 1)).toBe(0);
  });

  it("a partial settlement reduces but doesn't zero the balance", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1, payers: null,
      taxAmount: 0,
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [{ price: rupeesToPaise("200"), assignments: equalAssignments([1, 2]) }], // Bob owes Alice 100
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
      paidByMemberId: 1, payers: null,
      taxAmount: rupeesToPaise("180"),
      tipAmount: rupeesToPaise("50"),
      serviceFeeAmount: rupeesToPaise("20"),
      discountAmount: rupeesToPaise("10"),
      items: [{ price: rupeesToPaise("1000"), assignments: equalAssignments([1, 2, 3]) }],
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

describe("computeItemShares — split types", () => {
  it("equal: splits the item price evenly with the paise-remainder rule", () => {
    const item: BillItemForBalance = { price: rupeesToPaise("100"), assignments: equalAssignments([1, 2, 3]) };
    const shares = computeItemShares(item);
    expect(shares.get(1)).toBe(rupeesToPaise("33.34"));
    expect(shares.get(2)).toBe(rupeesToPaise("33.33"));
    expect(shares.get(3)).toBe(rupeesToPaise("33.33"));
  });

  it("percentage: 60/40 split of an item sums to exactly the item price", () => {
    const item: BillItemForBalance = {
      price: rupeesToPaise("50"),
      assignments: [
        { memberId: 1, splitType: "percentage", percentage: 60 },
        { memberId: 2, splitType: "percentage", percentage: 40 },
      ],
    };
    const shares = computeItemShares(item);
    expect(shares.get(1)).toBe(rupeesToPaise("30"));
    expect(shares.get(2)).toBe(rupeesToPaise("20"));
  });

  it("percentage: three-way split that doesn't divide evenly still sums exactly", () => {
    const item: BillItemForBalance = {
      price: rupeesToPaise("100"),
      assignments: [
        { memberId: 1, splitType: "percentage", percentage: 34 },
        { memberId: 2, splitType: "percentage", percentage: 33 },
        { memberId: 3, splitType: "percentage", percentage: 33 },
      ],
    };
    const shares = computeItemShares(item);
    const sum = [...shares.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(rupeesToPaise("100"));
  });

  it("ratio: 2:1:1 split allocates proportionally and sums exactly", () => {
    const item: BillItemForBalance = {
      price: rupeesToPaise("40"),
      assignments: [
        { memberId: 1, splitType: "ratio", ratio: 2 },
        { memberId: 2, splitType: "ratio", ratio: 1 },
        { memberId: 3, splitType: "ratio", ratio: 1 },
      ],
    };
    const shares = computeItemShares(item);
    expect(shares.get(1)).toBe(rupeesToPaise("20"));
    expect(shares.get(2)).toBe(rupeesToPaise("10"));
    expect(shares.get(3)).toBe(rupeesToPaise("10"));
  });

  it("custom: uses the exact paise amounts specified per person", () => {
    const item: BillItemForBalance = {
      price: rupeesToPaise("70"),
      assignments: [
        { memberId: 1, splitType: "custom", customAmount: rupeesToPaise("50") },
        { memberId: 2, splitType: "custom", customAmount: rupeesToPaise("20") },
      ],
    };
    const shares = computeItemShares(item);
    expect(shares.get(1)).toBe(rupeesToPaise("50"));
    expect(shares.get(2)).toBe(rupeesToPaise("20"));
  });

  it("an item with no assignments splits to nobody", () => {
    const item: BillItemForBalance = { price: rupeesToPaise("100"), assignments: [] };
    expect(computeItemShares(item).size).toBe(0);
  });
});

describe("computeBalances — multi-item bills with mixed split types", () => {
  it("restaurant scenario: solo item, equal-shared item, percentage item, custom item, ratio item, plus tax and tip", () => {
    // Alice paid. Pasta (₹450) is Alice's alone. Pizza (₹600) split equally
    // 3 ways. Wine (₹500) split 60/40 between Alice and Bob. Dessert (₹300)
    // as custom amounts. Appetizer (₹200) split 2:1 between Bob and Carol.
    const bill: BillForBalance = {
      paidByMemberId: 1, payers: null,
      taxAmount: rupeesToPaise("100"),
      tipAmount: rupeesToPaise("100"),
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [
        { price: rupeesToPaise("450"), assignments: equalAssignments([1]) },
        { price: rupeesToPaise("600"), assignments: equalAssignments([1, 2, 3]) },
        {
          price: rupeesToPaise("500"),
          assignments: [
            { memberId: 1, splitType: "percentage", percentage: 60 },
            { memberId: 2, splitType: "percentage", percentage: 40 },
          ],
        },
        {
          price: rupeesToPaise("300"),
          assignments: [
            { memberId: 2, splitType: "custom", customAmount: rupeesToPaise("180") },
            { memberId: 3, splitType: "custom", customAmount: rupeesToPaise("120") },
          ],
        },
        {
          price: rupeesToPaise("200"),
          assignments: [
            { memberId: 2, splitType: "ratio", ratio: 2 },
            { memberId: 3, splitType: "ratio", ratio: 1 },
          ],
        },
      ],
    };
    const balances = computeBalances([bill], []);
    const bobOwesAlice = -getPairwiseBalance(balances, 1, 2);
    const carolOwesAlice = -getPairwiseBalance(balances, 1, 3);

    const itemsTotal =
      rupeesToPaise("450") + rupeesToPaise("600") + rupeesToPaise("500") + rupeesToPaise("300") + rupeesToPaise("200");
    const grandTotal = itemsTotal + rupeesToPaise("100") + rupeesToPaise("100");
    const aliceOwnShare = grandTotal - bobOwesAlice - carolOwesAlice;

    // The invariant: every paise is accounted for across the three people.
    expect(aliceOwnShare + bobOwesAlice + carolOwesAlice).toBe(grandTotal);
    expect(bobOwesAlice).toBeGreaterThan(0);
    expect(carolOwesAlice).toBeGreaterThan(0);
  });

  it("a bill with one unassigned item contributes only its assigned items to balances", () => {
    const bill: BillForBalance = {
      paidByMemberId: 1, payers: null,
      taxAmount: rupeesToPaise("10"),
      tipAmount: 0,
      serviceFeeAmount: 0,
      discountAmount: 0,
      items: [
        { price: rupeesToPaise("100"), assignments: equalAssignments([1, 2]) },
        { price: rupeesToPaise("50"), assignments: [] }, // unassigned — excluded
      ],
    };
    const balances = computeBalances([bill], []);
    const bobOwesAlice = -getPairwiseBalance(balances, 1, 2);
    // Bob's share is only of the assigned ₹100 item plus its tax share — the
    // unassigned ₹50 item contributes to nobody's balance yet.
    expect(bobOwesAlice).toBe(rupeesToPaise("50") + rupeesToPaise("5"));
  });
});

describe("property: sum of shares always equals the bill's grand total (fully-assigned bills)", () => {
  function pseudoRandom(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  it("holds across 200 randomly generated fully-assigned bills", () => {
    const rand = pseudoRandom(42);
    const memberPool = [1, 2, 3, 4, 5];

    for (let trial = 0; trial < 200; trial++) {
      const payerId = memberPool[Math.floor(rand() * memberPool.length)];
      const itemCount = 1 + Math.floor(rand() * 4);
      const items: BillItemForBalance[] = [];

      for (let i = 0; i < itemCount; i++) {
        const price = 1 + Math.floor(rand() * 100000);
        const assigneeCount = 1 + Math.floor(rand() * memberPool.length);
        const assignees = [...memberPool].sort(() => rand() - 0.5).slice(0, assigneeCount);
        const splitRoll = rand();

        if (splitRoll < 0.4) {
          items.push({ price, assignments: assignees.map((memberId) => ({ memberId, splitType: "equal" as const })) });
        } else if (splitRoll < 0.6) {
          // Random percentages that sum to exactly 100.
          const raw = assignees.map(() => 1 + Math.floor(rand() * 50));
          const total = raw.reduce((a, b) => a + b, 0);
          const pcts = raw.map((v) => Math.floor((v / total) * 100));
          const gap = 100 - pcts.reduce((a, b) => a + b, 0);
          pcts[0] += gap;
          items.push({
            price,
            assignments: assignees.map((memberId, idx) => ({
              memberId,
              splitType: "percentage" as const,
              percentage: pcts[idx],
            })),
          });
        } else if (splitRoll < 0.8) {
          items.push({
            price,
            assignments: assignees.map((memberId) => ({
              memberId,
              splitType: "ratio" as const,
              ratio: 1 + Math.floor(rand() * 5),
            })),
          });
        } else {
          // Random custom amounts that sum to exactly the item price.
          const raw = assignees.map(() => 1 + Math.floor(rand() * 1000));
          const total = raw.reduce((a, b) => a + b, 0);
          const amounts = raw.map((v) => Math.floor((v / total) * price));
          const gap = price - amounts.reduce((a, b) => a + b, 0);
          amounts[0] += gap;
          items.push({
            price,
            assignments: assignees.map((memberId, idx) => ({
              memberId,
              splitType: "custom" as const,
              customAmount: amounts[idx],
            })),
          });
        }
      }

      const bill: BillForBalance = {
        paidByMemberId: payerId, payers: null,
        taxAmount: Math.floor(rand() * 5000),
        tipAmount: Math.floor(rand() * 5000),
        serviceFeeAmount: Math.floor(rand() * 2000),
        discountAmount: Math.floor(rand() * 1000),
        items,
      };

      const itemsTotal = items.reduce((a, item) => a + item.price, 0);
      const grandTotal =
        itemsTotal + bill.taxAmount + bill.tipAmount + bill.serviceFeeAmount - bill.discountAmount;

      const balances = computeBalances([bill], []);
      const owedToPayer = memberPool
        .filter((id) => id !== payerId)
        .reduce((sum, id) => sum - getPairwiseBalance(balances, payerId, id), 0);
      const payerOwnShare = grandTotal - owedToPayer;

      expect(payerOwnShare + owedToPayer).toBe(grandTotal);
    }
  });
});

describe("summarizeMember — one person's money in a group", () => {
  const charges = { taxAmount: 0, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 0 };
  // Alice pays ₹1,200 for dinner split three ways; Bob pays ₹900 for the movie split three ways.
  const dinner: BillForSummary = { ...charges, paidByMemberId: 1, payers: null, grandTotal: 120000, items: [{ price: 120000, assignments: equalAssignments([1, 2, 3]) }] };
  const movie: BillForSummary = { ...charges, paidByMemberId: 2, payers: null, grandTotal: 90000, items: [{ price: 90000, assignments: equalAssignments([1, 2, 3]) }] };

  it("shows Alice's share, what she paid and her net, which is paid minus share", () => {
    expect(summarizeMember([dinner, movie], [], 1)).toEqual({
      groupSpent: 210000,
      unassigned: 0,
      share: 70000,
      paid: 120000,
      net: 50000,
      billShares: [40000, 30000],
    });
  });

  it("counts a member who paid nothing and had no items as zero, not missing", () => {
    expect(summarizeMember([dinner], [], 4)).toMatchObject({ share: 0, paid: 0, net: 0, billShares: [0] });
  });

  it("includes tax, tip and discounts in the share, with remainders adding up to the bill", () => {
    const taxed: BillForSummary = { paidByMemberId: 1, payers: null, taxAmount: 100, tipAmount: 0, serviceFeeAmount: 0, discountAmount: 1, grandTotal: 199, items: [{ price: 100, assignments: equalAssignments([1, 2, 3]) }] };
    const shares = [1, 2, 3].map((id) => summarizeMember([taxed], [], id).share);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(199);
  });

  it("takes settlements into the net but never into what was paid", () => {
    const settled = summarizeMember([dinner, movie], [{ payerMemberId: 3, recipientMemberId: 1, amount: 40000 }], 1);
    expect(settled).toMatchObject({ paid: 120000, share: 70000, net: 10000 });
  });

  it("reports unassigned items separately, and they are nobody's share", () => {
    const partly: BillForSummary = { ...charges, paidByMemberId: 1, payers: null, grandTotal: 50000, items: [{ price: 30000, assignments: equalAssignments([1, 2]) }, { price: 20000, assignments: [] }] };
    expect(summarizeMember([partly], [], 1)).toMatchObject({ groupSpent: 50000, unassigned: 20000, share: 15000, paid: 50000, net: 15000 });
  });

  it("everyone's net adds to zero, and with nothing settled or unassigned net = paid - share", () => {
    const people = [1, 2, 3];
    const nets = people.map((id) => summarizeMember([dinner, movie], [], id));
    expect(nets.reduce((sum, s) => sum + s.net, 0)).toBe(0);
    for (const s of nets) expect(s.net).toBe(s.paid - s.share);
    expect(nets.reduce((sum, s) => sum + s.share, 0)).toBe(nets[0].groupSpent);
  });
});
