import { describe, expect, it } from "vitest";
import {
  blankItem,
  buildCreateBill,
  computeTotals,
  draftFromExtraction,
  itemsNeedingReview,
  mismatchOf,
  parseMoney,
  roundOffToMatchReceipt,
} from "./receipt-draft";
import type { ReceiptExtraction } from "@/hooks/use-bills";

// The real Ganbei receipt that was used to test OCR (paise).
const GANBEI: ReceiptExtraction = {
  merchant: "Ganbei Restaurant Pvt Ltd", billDate: "2026-10-31",
  items: [
    ["Vodka Prawns", 65900], ["Mac N Cheese Bites", 34900], ["Pothu Karuthu Irunthathu", 47900], ["Harissa Chicken Wings", 47900],
    ["Pahadi Mushroom Tikka", 47900], ["Wheat Scandal (60ml)", 10000], ["Mango Tango (60ml)", 10000], ["Mango Tango (1500ml)", 130000],
    ["Wheat Scandal (500ml)", 44000], ["Mango Tango (500ml)", 44000], ["Appam (1pcs)", 55000], ["Veg Stew", 35900],
    ["Chicken Pal Curry", 44900], ["Chemmeen Mangaacharil Chadiyathu", 69900], ["Kerala Porotta", 5000], ["Chicken Alfredo Pasta (Penne)", 51500],
  ].map(([name, price]) => ({ name: name as string, price: price as number, quantity: name === "Appam (1pcs)" ? 11 : 1, confidence: "high" as const })),
  subtotalAmount: 744700, taxAmount: 25336, tipAmount: null, serviceFeeAmount: 44682, discountAmount: null, roundOffAmount: -18,
  totalAmount: 814700, overallConfidence: "high", totalsMismatch: null,
};
const target: Parameters<typeof buildCreateBill>[1] = { groupId: 7, payerMemberId: 1, memberIds: [1, 2, 3], imagePath: "5/abcdefghijklmnop.jpg" };

describe("parseMoney", () => {
  it("reads rupee text into paise, tolerating ₹, commas and spaces", () => {
    expect(parseMoney("1,300.50")).toBe(130050);
    expect(parseMoney(" ₹ 659 ")).toBe(65900);
    expect(parseMoney("0.18")).toBe(18);
  });
  it("rejects junk, empty and (unless allowed) negatives", () => {
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("12.345")).toBeNull();
    expect(parseMoney("-5")).toBeNull();
    expect(parseMoney("-0.18", true)).toBe(-18);
  });
});

describe("draftFromExtraction + totals on the real Ganbei receipt", () => {
  const draft = draftFromExtraction(GANBEI, "2026-11-01");
  it("carries over every line and charge exactly", () => {
    expect(draft.items).toHaveLength(16);
    expect(draft.description).toBe("Ganbei Restaurant Pvt Ltd");
    expect(draft.billDate).toBe("2026-10-31");
    expect(draft).toMatchObject({ tax: "253.36", service: "446.82", roundOff: "-0.18", tip: "", discount: "" });
  });
  it("adds up to the printed ₹8,147.00 with no mismatch", () => {
    const t = computeTotals(draft);
    expect(t.itemsSubtotal).toBe(744700);
    expect(t.grandTotal).toBe(814700);
    expect(mismatchOf(draft)).toBeNull();
  });
  it("flags a real mistake once an item price is edited, with the exact difference", () => {
    const edited = { ...draft, items: draft.items.map((i, n) => (n === 0 ? { ...i, price: "700" } : i)) }; // 659 -> 700
    expect(mismatchOf(edited)).toEqual({ computed: 818800, receiptTotal: 814700, delta: 4100 });
  });
  it("can offer a round-off that makes it match again", () => {
    const edited = { ...draft, items: draft.items.map((i, n) => (n === 0 ? { ...i, price: "700" } : i)) };
    expect(roundOffToMatchReceipt(edited)).toBe("-41.18");
    expect(mismatchOf({ ...edited, roundOff: roundOffToMatchReceipt(edited) })).toBeNull();
  });
});

describe("draftFromExtraction edge cases", () => {
  it("falls back to one blank row, today's date and no mismatch when nothing was read", () => {
    const d = draftFromExtraction(null, "2026-11-01");
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ name: "", price: "", quantity: "1" });
    expect(d.billDate).toBe("2026-11-01");
    expect(mismatchOf(d)).toBeNull();
  });
  it("ignores a malformed date from the model", () => {
    expect(draftFromExtraction({ ...GANBEI, billDate: "31/10/26" }, "2026-11-01").billDate).toBe("2026-11-01");
  });
  it("lists low-confidence lines for the Needs review summary", () => {
    const d = draftFromExtraction({ ...GANBEI, items: [{ ...GANBEI.items[0], confidence: "low" }, GANBEI.items[1]] }, "2026-11-01");
    expect(itemsNeedingReview(d).map((i) => i.name)).toEqual(["Vodka Prawns"]);
  });
});

describe("buildCreateBill", () => {
  const draft = draftFromExtraction(GANBEI, "2026-11-01");

  it("builds the exact request: line totals, equal split among everyone chosen, photo attached", () => {
    const r = buildCreateBill(draft, target);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({ groupId: 7, paidByMemberId: 1, subtotalAmount: 744700, taxAmount: 25336, serviceFeeAmount: 44682, tipAmount: 0, receiptImageUrl: "5/abcdefghijklmnop.jpg", billDate: "2026-10-31" });
    expect(r.input.items).toHaveLength(16);
    expect(r.input.items[10]).toMatchObject({ name: "Appam (1pcs)", price: 55000, quantity: 11 }); // price stays the line total
    expect(r.input.items[0].assignments).toEqual([1, 2, 3].map((memberId) => ({ memberId, splitType: "equal" })));
  });
  it("saves a printed minus round-off as a small discount so the bill total is exact", () => {
    const r = buildCreateBill(draft, target);
    if (!r.ok) throw new Error(r.message);
    expect(r.input.discountAmount).toBe(18);
    const { subtotalAmount, taxAmount, tipAmount, serviceFeeAmount, discountAmount } = r.input;
    expect(subtotalAmount + taxAmount + tipAmount + serviceFeeAmount - discountAmount).toBe(814700);
  });
  it("saves a plus round-off as a small extra charge", () => {
    const r = buildCreateBill({ ...draft, roundOff: "0.40", service: "10" }, target);
    if (!r.ok) throw new Error(r.message);
    expect(r.input.serviceFeeAmount).toBe(1040);
    expect(r.input.discountAmount).toBe(0);
  });
  it("says what's wrong in plain words", () => {
    const msg = (d: typeof draft, t = target) => { const r = buildCreateBill(d, t); return r.ok ? "OK" : r.message; };
    expect(msg({ ...draft, description: " " })).toMatch(/name/);
    expect(msg(draft, { ...target, groupId: null })).toMatch(/group/);
    expect(msg(draft, { ...target, payerMemberId: null })).toMatch(/who paid/);
    expect(msg(draft, { ...target, memberIds: [] })).toMatch(/at least one person/);
    expect(msg({ ...draft, tax: "abc" })).toMatch(/tax/);
    expect(msg({ ...draft, items: [{ ...blankItem(), price: "10" }] })).toMatch(/needs a name/);
    expect(msg({ ...draft, items: [{ ...blankItem(), name: "Tea" }] })).toMatch(/price above zero/);
    expect(msg({ ...draft, items: [{ ...blankItem(), name: "Tea", price: "10", quantity: "1.5" }] })).toMatch(/whole-number quantity/);
    expect(msg({ ...draft, items: [] })).toMatch(/at least one item/);
  });
  it("leaves out the photo when there isn't one", () => {
    const r = buildCreateBill(draft, { ...target, imagePath: null });
    expect(r.ok && "receiptImageUrl" in r.input).toBe(false);
  });
});

describe("tax already included in the prices (AIRR TOAST receipt)", () => {
  const AIRR: ReceiptExtraction = {
    merchant: "AIRR TOAST", billDate: "2026-10-11",
    items: [
      { name: "Affogato", price: 45000, quantity: 1, confidence: "low" },
      { name: "Mochaccino", price: 37000, quantity: 1, confidence: "high" },
      { name: "Iced Latte", price: 34000, quantity: 1, confidence: "high" },
    ],
    subtotalAmount: null, taxAmount: null, taxIncludedAmount: 5524, tipAmount: null, serviceFeeAmount: null, discountAmount: null,
    roundOffAmount: null, totalAmount: 116000, overallConfidence: "high", totalsMismatch: null,
  };
  const draft = draftFromExtraction(AIRR, "2026-11-01");

  it("is shown for information but never added: the bill is ₹1,160.00, not ₹1,215.24", () => {
    expect(draft.tax).toBe("");
    expect(draft.taxIncluded).toBe(5524);
    expect(computeTotals(draft).grandTotal).toBe(116000);
    expect(mismatchOf(draft)).toBeNull();
    const r = buildCreateBill(draft, target);
    if (!r.ok) throw new Error(r.message);
    expect(r.input.taxAmount).toBe(0);
    expect(r.input.subtotalAmount).toBe(116000);
  });
  it("flags only the genuinely uncertain line", () => {
    expect(itemsNeedingReview(draft).map((i) => i.name)).toEqual(["Affogato"]);
  });
});
