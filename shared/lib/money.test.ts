import { describe, it, expect } from "vitest";
import {
  formatPaise,
  rupeesToPaise,
  paiseToRupeeInput,
  splitEqually,
  allocateProportionally,
} from "./money.js";

describe("rupeesToPaise / paiseToRupeeInput", () => {
  it("parses whole rupees", () => {
    expect(rupeesToPaise("100")).toBe(10000);
  });

  it("parses two-decimal rupees", () => {
    expect(rupeesToPaise("33.33")).toBe(3333);
  });

  it("pads a single decimal digit", () => {
    expect(rupeesToPaise("10.5")).toBe(1050);
  });

  it("round-trips through paiseToRupeeInput", () => {
    expect(paiseToRupeeInput(rupeesToPaise("1234.56"))).toBe("1234.56");
  });

  it("rejects malformed input", () => {
    expect(() => rupeesToPaise("abc")).toThrow();
    expect(() => rupeesToPaise("1.234")).toThrow();
  });
});

describe("formatPaise", () => {
  it("formats as INR with the rupee symbol", () => {
    expect(formatPaise(123456)).toBe("₹1,234.56");
  });
});

describe("splitEqually", () => {
  it("splits evenly with no remainder", () => {
    const shares = splitEqually(9000, [1, 2, 3]);
    expect([...shares.values()]).toEqual([3000, 3000, 3000]);
  });

  it("distributes remainder paise to the lowest member ids first (100 / 3)", () => {
    const shares = splitEqually(100, [3, 1, 2]);
    expect(shares.get(1)).toBe(34);
    expect(shares.get(2)).toBe(33);
    expect(shares.get(3)).toBe(33);
  });

  it("distributes remainder for ₹100 among 3 as ₹33.34/₹33.33/₹33.33", () => {
    const shares = splitEqually(rupeesToPaise("100"), [1, 2, 3]);
    expect(paiseToRupeeInput(shares.get(1)!)).toBe("33.34");
    expect(paiseToRupeeInput(shares.get(2)!)).toBe("33.33");
    expect(paiseToRupeeInput(shares.get(3)!)).toBe("33.33");
  });

  it("sums to exactly the total regardless of remainder", () => {
    for (const [total, n] of [[100, 3], [1, 7], [9999, 4], [1000000, 13]] as const) {
      const shares = splitEqually(total, Array.from({ length: n }, (_, i) => i + 1));
      const sum = [...shares.values()].reduce((a, b) => a + b, 0);
      expect(sum).toBe(total);
    }
  });

  it("throws for an empty member list", () => {
    expect(() => splitEqually(100, [])).toThrow();
  });
});

describe("allocateProportionally", () => {
  it("allocates proportionally to weights", () => {
    const weights = new Map([
      [1, 6000],
      [2, 3000],
      [3, 1000],
    ]);
    const shares = allocateProportionally(1000, weights);
    expect(shares.get(1)).toBe(600);
    expect(shares.get(2)).toBe(300);
    expect(shares.get(3)).toBe(100);
  });

  it("gives zero to a member with zero weight", () => {
    const weights = new Map([
      [1, 100],
      [2, 0],
    ]);
    const shares = allocateProportionally(50, weights);
    expect(shares.get(2)).toBe(0);
    expect(shares.get(1)).toBe(50);
  });

  it("sums to exactly the total even with rounding", () => {
    const weights = new Map([
      [1, 333],
      [2, 333],
      [3, 334],
    ]);
    const shares = allocateProportionally(180, weights);
    const sum = [...shares.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(180);
  });

  it("returns all zeros when the total is zero", () => {
    const weights = new Map([
      [1, 100],
      [2, 200],
    ]);
    const shares = allocateProportionally(0, weights);
    expect(shares.get(1)).toBe(0);
    expect(shares.get(2)).toBe(0);
  });
});

describe("bill share invariant (subtotal + tax − discount, equal split)", () => {
  it("₹1000 + ₹180 tax split equally among 3 sums to exactly ₹1180", () => {
    const memberIds = [1, 2, 3];
    const subtotal = rupeesToPaise("1000");
    const tax = rupeesToPaise("180");

    const itemShares = splitEqually(subtotal, memberIds);
    const taxShares = allocateProportionally(tax, itemShares);

    let total = 0;
    for (const id of memberIds) {
      total += itemShares.get(id)! + taxShares.get(id)!;
    }
    expect(total).toBe(subtotal + tax);
    expect(paiseToRupeeInput(total)).toBe("1180.00");
  });

  it("a member with zero items owes zero tax/tip on that bill", () => {
    const itemShares = new Map([
      [1, 5000],
      [2, 0],
    ]);
    const taxShares = allocateProportionally(900, itemShares);
    expect(taxShares.get(2)).toBe(0);
  });

  it("discount allocated the same way as tax reduces the grand total exactly", () => {
    const memberIds = [1, 2, 3];
    const subtotal = rupeesToPaise("999");
    const discount = rupeesToPaise("99");

    const itemShares = splitEqually(subtotal, memberIds);
    const discountShares = allocateProportionally(discount, itemShares);

    let total = 0;
    for (const id of memberIds) {
      total += itemShares.get(id)! - discountShares.get(id)!;
    }
    expect(total).toBe(subtotal - discount);
  });
});
