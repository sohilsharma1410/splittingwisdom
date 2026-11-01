import { describe, expect, it } from "vitest";
import { computeTotalsMismatch, type ExtractedItem } from "./receipt-ocr.js";

const item = (price: number, quantity = 1): ExtractedItem => ({ name: "x", price, quantity, confidence: "high" });
const none = { tax: null, tip: null, serviceFee: null, discount: null };

describe("computeTotalsMismatch — price is the line total", () => {
  it("does NOT multiply by quantity: '4 naan 60.00' is ₹60 in total", () => {
    // 250.00 + 60.00 (4 naan) + 220.00 + 80.00 (2 sodas) = 610.00, + 30.50 tax + 30.50 service = 671.00
    const items = [item(25000), item(6000, 4), item(22000), item(8000, 2)];
    expect(computeTotalsMismatch(items, { ...none, tax: 3050, serviceFee: 3050 }, 67100)).toBeNull();
  });
  it("reports the delta when the items really don't add up", () => {
    expect(computeTotalsMismatch([item(10000), item(5000)], none, 16000)).toEqual({ itemsSum: 15000, extractedTotal: 16000, delta: -1000 });
  });
  it("adds tax, tip and fee and subtracts the discount", () => {
    expect(computeTotalsMismatch([item(10000)], { tax: 500, tip: 1000, serviceFee: 200, discount: 700 }, 11000)).toBeNull();
  });
  it("can't judge without a printed total", () => {
    expect(computeTotalsMismatch([item(10000)], none, null)).toBeNull();
  });
  it("a printed round-off is part of the arithmetic (Ganbei receipt: 7447 + 253.36 + 446.82 - 0.18 = 8147)", () => {
    expect(computeTotalsMismatch([item(744700)], { tax: 25336, tip: null, serviceFee: 44682, discount: null, roundOff: -18 }, 814700)).toBeNull();
  });
  it("ignores sub-50-paise rounding noise but still flags a real gap", () => {
    expect(computeTotalsMismatch([item(744700)], { ...none, tax: 25336, serviceFee: 44682 }, 814700)).toBeNull(); // off by 18 paise
    expect(computeTotalsMismatch([item(10000)], none, 10100)).toEqual({ itemsSum: 10000, extractedTotal: 10100, delta: -100 });
  });
});
