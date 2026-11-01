import { describe, expect, it } from "vitest";
import { readNumber, toPaise } from "./speech-numbers.js";
import { billFromSpeech } from "./speech-bill.js";

const paise = (text: string) => {
  const n = readNumber(text.split(" "), 0);
  return n ? toPaise(n) : null;
};
const lines = (text: string) => billFromSpeech(text).items.map((i) => [i.name, i.quantity, i.price, i.confidence]);

describe("spoken numbers", () => {
  it("reads digits, with commas and decimals", () => {
    expect(paise("250")).toBe(25000);
    expect(paise("1,250")).toBe(125000);
    expect(paise("10.5")).toBe(1050);
    expect(paise("99.99")).toBe(9999);
  });
  it("reads number words", () => {
    expect(paise("eighty")).toBe(8000);
    expect(paise("two hundred fifty")).toBe(25000);
    expect(paise("two hundred and fifty")).toBe(25000);
    expect(paise("one thousand two hundred")).toBe(120000);
    expect(paise("two lakh")).toBe(20_000_000);
    expect(paise("hundred")).toBe(10000);
    expect(paise("ten point five")).toBe(1050);
  });
  it("is not fooled by words that aren't numbers", () => {
    expect(paise("naan")).toBeNull();
    expect(paise("and fifty")).toBeNull();
  });
});

describe("a bill described out loud", () => {
  it("reads items with a quantity and a price each", () => {
    expect(lines("two paneer tikka 250 each, naan 80")).toEqual([
      ["Paneer Tikka", 2, 50000, "high"],
      ["Naan", 1, 8000, "high"],
    ]);
  });
  it("reads 'for' as the price of the whole line", () => {
    expect(lines("four naan for sixty")).toEqual([["Naan", 4, 6000, "high"]]);
  });
  it("is unsure whether 'two naan 160' means each or in all, and says so", () => {
    expect(lines("2 naan 160")).toEqual([["Naan", 2, 16000, "low"]]);
  });
  it("keeps an item with no price, flagged, rather than inventing one", () => {
    expect(lines("one veg biryani")).toEqual([["Veg Biryani", 1, 0, "low"]]);
  });
  it("reads tax, tip, service charge, discount and the total", () => {
    const bill = billFromSpeech("paneer tikka 500, naan 100, tax 30, tip 20, service charge 40, discount 50, total 640");
    expect(bill).toMatchObject({ taxAmount: 3000, tipAmount: 2000, serviceFeeAmount: 4000, discountAmount: 5000, totalAmount: 64000 });
    expect(bill.items).toHaveLength(2);
  });
  it("works out a percentage in whole paise from the items", () => {
    expect(billFromSpeech("naan 100, paneer 233, GST 5 percent").taxAmount).toBe(1665); // 5% of 333.00 = 16.65
    expect(billFromSpeech("naan 99.99, tip 10%").tipAmount).toBe(1000); // 9.999 rounds to 10.00
    expect(billFromSpeech("naan 100, service charge 5 percent, discount 10 percent")).toMatchObject({ serviceFeeAmount: 500, discountAmount: 1000 });
  });
  it("won't guess a percentage when no item price has been said yet", () => {
    const bill = billFromSpeech("tax 5 percent");
    expect(bill.taxAmount).toBeNull();
    expect(bill.doubts).toHaveLength(1);
  });
  it("copes with number words and thousands", () => {
    expect(lines("butter chicken three hundred and fifty, jeera rice one thousand two hundred")).toEqual([
      ["Butter Chicken", 1, 35000, "high"],
      ["Jeera Rice", 1, 120000, "high"],
    ]);
  });
  it("takes a bill name", () => {
    expect(billFromSpeech("bill name ganbei restaurant, naan 80").merchant).toBe("Ganbei Restaurant");
  });
  it("says so when a charge has no amount, and never sets an amount from nothing", () => {
    const bill = billFromSpeech("naan 80, tax");
    expect(bill.taxAmount).toBeNull();
    expect(bill.doubts[0]).toMatch(/No amount/);
  });
  it("returns nothing for silence or unrelated chatter without crashing", () => {
    expect(billFromSpeech("").items).toEqual([]);
    expect(billFromSpeech("   ").items).toEqual([]);
  });
});
