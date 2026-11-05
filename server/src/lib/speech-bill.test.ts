import { describe, expect, it } from "vitest";
import { readNumber, toPaise } from "./speech-numbers.js";
import { billFromSpeech } from "./speech-bill.js";
import { BILL_DEV_CASES, BILL_HELD_OUT_CASES, BILL_MEMBERS, gradeBill, type BillCase } from "./speech-bill.eval-data.js";

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

  it("keeps who had a dish out of its name and hands it on", () => {
    const bill = billFromSpeech("Curd shared by me 50, thali non veg by only Bob 140");
    expect(bill.items.map((i) => [i.name, i.price, i.who])).toEqual([
      ["Curd", 5000, "shared by me"],
      ["Thali Non Veg", 14000, "by only bob"],
    ]);
    expect(bill.doubts).toEqual([]);
  });
  it("reads names after the price, on their own, and across 'and'", () => {
    const names = ["Ann", "Bob", "Cat"];
    const bill = billFromSpeech("Chicken tikka 250. Only Bob. Curd 50 only me, thali 140, Bob and Cat. Chicken lollipop 250 shared by everyone. Naan 80 for Cat", names);
    expect(bill.items.map((i) => [i.name, i.price, i.who])).toEqual([
      ["Chicken Tikka", 25000, "only bob"],
      ["Curd", 5000, "only me"],
      ["Thali", 14000, "bob cat"],
      ["Chicken Lollipop", 25000, "shared by everyone"],
      ["Naan", 8000, "cat"],
    ]);
    expect(bill.doubts).toEqual([]);
  });
  it("doesn't take a dish for a person", () => {
    expect(billFromSpeech("Paneer tikka 250, naan 80", ["Ann", "Bob"]).items.map((i) => [i.name, i.who])).toEqual([["Paneer Tikka", ""], ["Naan", ""]]);
  });
});

describe("a bill spoken the way people actually pause (real recordings on the Pi)", () => {
  const group = ["Pi", "Sohil", "Pytester 1", "Pytester 2"];
  const read = (text: string, names: string[] = group) => billFromSpeech(text, names).items.map((i) => [i.name, i.quantity, i.price, i.who]);
  const said = "2 watermelon juice, 150 each, shared by me and Sohil. 1 coconut pudding, 500 rupees, shared by Pytester 2 and Pytester 1. 1 guitar avocado toast, 2 25 rupees, had by Sohil.";

  it("keeps a price said after a comma with its item, and the people too", () => {
    expect(read(said)).toEqual([
      ["Watermelon Juice", 2, 30000, "shared by me sohil"],
      ["Coconut Pudding", 1, 50000, "shared by pytester 2 pytester 1"],
      ["Guitar Avocado Toast", 1, 22500, "had by sohil"],
    ]);
  });
  it("does the same before a group is chosen", () => {
    expect(read(said, [])).toEqual([
      ["Watermelon Juice", 2, 30000, "shared by me sohil"],
      ["Coconut Pudding", 1, 50000, "shared by pytester 2 pytester 1"],
      ["Guitar Avocado Toast", 1, 22500, "had by sohil"],
    ]);
  });
  it("reads '2 25 rupees' as 225, and asks for it to be checked", () => {
    const bill = billFromSpeech(said, group);
    expect(bill.items[2].confidence).toBe("low");
    expect(bill.doubts).toEqual(['Guitar Avocado Toast: heard "2 25" as 225. Check the price.']);
  });
  it("never takes the number in someone's name for a price", () => {
    expect(read("Coconut pudding 500 split by pi tester 1 and Sohil")).toEqual([["Coconut Pudding", 1, 50000, "split by pi tester 1 sohil"]]);
    expect(read("paneer tikka 300 split by pi tester one and Sohil", [])).toEqual([["Paneer Tikka", 1, 30000, "split by pi tester one sohil"]]);
  });
  it("takes the restaurant's name however it's said", () => {
    for (const text of ["We ate at Ganbei. Naan 80", "Dinner at Ganbei, naan 80", "Restaurant name is Ganbei, naan 80", "Restaurant Ganbei. Naan 80", "Bill name Ganbei, naan 80"]) {
      const bill = billFromSpeech(text, group);
      expect([text, bill.merchant, bill.items.map((i) => i.name)]).toEqual([text, "Ganbei", ["Naan"]]);
    }
  });
  it("keeps 'and' inside a dish when the first half has no price", () => {
    expect(read("mac and cheese 300 only Sohil, naan 80 and dal 120")).toEqual([
      ["Mac And Cheese", 1, 30000, "only sohil"],
      ["Naan", 1, 8000, ""],
      ["Dal", 1, 12000, ""],
    ]);
  });
  it("won't fill in anyone for a dish when a name said for it isn't in the group", () => {
    const bill = billFromSpeech("paneer tikka 250 shared by me and Ravi, naan 80 only Priya", group);
    expect(bill.items.map((i) => [i.name, i.price, i.whoUnclear])).toEqual([["Paneer Tikka", 25000, true], ["Naan", 8000, true]]);
    expect(bill.doubts).toEqual([
      `Paneer Tikka: couldn't tell who "ravi" is, so nobody was filled in for it.`,
      `Naan: couldn't tell who "priya" is, so nobody was filled in for it.`,
    ]);
  });
  it("says so when a price comes with no item, instead of making one up", () => {
    const bill = billFromSpeech("naan 80, 90", group);
    expect(bill.items.map((i) => [i.name, i.price])).toEqual([["Naan", 8000]]);
    expect(bill.doubts).toEqual([`Couldn't tell what "90" was.`]);
  });
});

describe("the bill test sentences (speech-bill.eval-data.ts)", () => {
  const names = BILL_MEMBERS.map((m) => m.name);
  const failures = (cases: BillCase[]) => cases.map((c) => [c.text, gradeBill(billFromSpeech(c.text, names), c)] as const).filter(([, wrong]) => wrong.length > 0);

  it("gets the tuning sentences right", () => {
    expect(failures(BILL_DEV_CASES)).toEqual([]);
  });
  it("gets at least as many held-out sentences right as when the language model was added", () => {
    // These are what the language model is for. Raise this only for a real improvement.
    expect(BILL_HELD_OUT_CASES.length - failures(BILL_HELD_OUT_CASES).length).toBeGreaterThanOrEqual(1);
  });
});
