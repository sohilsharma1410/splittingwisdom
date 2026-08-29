import { describe, it, expect } from "vitest";
import { billItemInputSchema } from "./schema.js";

describe("billItemInputSchema — split validation", () => {
  it("accepts an equal split with no extra fields", () => {
    const result = billItemInputSchema.safeParse({
      name: "Pizza",
      price: 60000,
      assignments: [
        { memberId: 1, splitType: "equal" },
        { memberId: 2, splitType: "equal" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an unassigned item (assignments empty)", () => {
    const result = billItemInputSchema.safeParse({
      name: "Fries",
      price: 20000,
      assignments: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts percentages that sum to exactly 100", () => {
    const result = billItemInputSchema.safeParse({
      name: "Wine",
      price: 50000,
      assignments: [
        { memberId: 1, splitType: "percentage", percentage: 60 },
        { memberId: 2, splitType: "percentage", percentage: 40 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects percentages that fall short of 100 and reports the gap", () => {
    const result = billItemInputSchema.safeParse({
      name: "Wine",
      price: 50000,
      assignments: [
        { memberId: 1, splitType: "percentage", percentage: 50 },
        { memberId: 2, splitType: "percentage", percentage: 30 },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("20 short of 100");
    }
  });

  it("rejects percentages that exceed 100", () => {
    const result = billItemInputSchema.safeParse({
      name: "Wine",
      price: 50000,
      assignments: [
        { memberId: 1, splitType: "percentage", percentage: 70 },
        { memberId: 2, splitType: "percentage", percentage: 50 },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("20 over 100");
    }
  });

  it("accepts custom amounts that sum to exactly the item price", () => {
    const result = billItemInputSchema.safeParse({
      name: "Dessert",
      price: 30000,
      assignments: [
        { memberId: 1, splitType: "custom", customAmount: 18000 },
        { memberId: 2, splitType: "custom", customAmount: 12000 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects custom amounts that don't sum to the item price and reports what's remaining", () => {
    const result = billItemInputSchema.safeParse({
      name: "Dessert",
      price: 30000,
      assignments: [
        { memberId: 1, splitType: "custom", customAmount: 10000 },
        { memberId: 2, splitType: "custom", customAmount: 5000 },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("₹150.00 left to assign");
    }
  });

  it("accepts a valid ratio split", () => {
    const result = billItemInputSchema.safeParse({
      name: "Appetizer",
      price: 20000,
      assignments: [
        { memberId: 1, splitType: "ratio", ratio: 2 },
        { memberId: 2, splitType: "ratio", ratio: 1 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-positive-integer ratio part", () => {
    const result = billItemInputSchema.safeParse({
      name: "Appetizer",
      price: 20000,
      assignments: [
        { memberId: 1, splitType: "ratio", ratio: 2 },
        { memberId: 2, splitType: "ratio", ratio: 0 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects mixed split types on the same item", () => {
    const result = billItemInputSchema.safeParse({
      name: "Mixed",
      price: 10000,
      assignments: [
        { memberId: 1, splitType: "equal" },
        { memberId: 2, splitType: "percentage", percentage: 100 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a percentage assignment missing its percentage value", () => {
    const result = billItemInputSchema.safeParse({
      name: "Wine",
      price: 50000,
      assignments: [{ memberId: 1, splitType: "percentage" }],
    });
    expect(result.success).toBe(false);
  });
});
