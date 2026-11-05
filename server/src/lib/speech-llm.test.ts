import { describe, expect, it } from "vitest";
import { billFromSpeech } from "./speech-bill.js";
import { askModel, billFromModel, checkAnswer, chooseReading, rulesNeedHelp, type ModelAnswer } from "./speech-llm.js";

const group = ["Pi", "Sohil", "Pytester 1", "Pytester 2"];
const said = "We ate at Ganbei. 2 watermelon juice, 150 each, shared by me and Sohil. Coconut pudding 500 split by pi tester 1. GST 5 percent. Total 829.";

const answer = (over: Partial<ModelAnswer> = {}): ModelAnswer => ({
  restaurant: "Ganbei",
  items: [
    { name: "Watermelon Juice", quantity: 2, price: 150, price_is: "each", people: ["me", "Sohil"] },
    { name: "Coconut Pudding", quantity: 1, price: 500, price_is: "line", people: ["pi tester 1"] },
  ],
  charges: [{ kind: "tax", amount: null, percent: 5 }],
  total: 829,
  ...over,
});
const check = (a: ModelAnswer, text = said) => checkAnswer(a, text, group, "Pi");

describe("holding the model's answer to what was said", () => {
  it("takes a reading where every number was said, and does the arithmetic itself in paise", () => {
    const result = check(answer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bill.items.map((i) => [i.name, i.quantity, i.price, i.who])).toEqual([
      ["Watermelon Juice", 2, 30000, "me and Sohil"],
      ["Coconut Pudding", 1, 50000, "pi tester 1"],
    ]);
    expect(result.bill).toMatchObject({ merchant: "Ganbei", taxAmount: 4000, totalAmount: 82900, doubts: [] });
  });

  it("throws the whole answer away for a price, quantity or percentage nobody said", () => {
    const juice = answer().items[0];
    expect(check(answer({ items: [{ ...juice, price: 160 }] }))).toEqual({ ok: false, reason: "a price that wasn't said" });
    expect(check(answer({ items: [{ ...juice, quantity: 3 }] }))).toEqual({ ok: false, reason: "a quantity that wasn't said" });
    expect(check(answer({ charges: [{ kind: "tip", amount: null, percent: 10 }] }))).toEqual({ ok: false, reason: "a percentage that wasn't said" });
    expect(check(answer({ charges: [{ kind: "service", amount: 75, percent: null }] }))).toEqual({ ok: false, reason: "a charge that wasn't said" });
  });

  it("won't take 'GST 5 percent' as ₹5, or 'discount 50' as 50% off", () => {
    expect(check(answer({ charges: [{ kind: "tax", amount: 5, percent: null }] }))).toEqual({ ok: false, reason: "a percentage read as an amount" });
    const text = "Biryani 350, discount 50.";
    const biryani = { name: "Biryani", quantity: 1, price: 350, price_is: "line" as const, people: [] };
    expect(check(answer({ restaurant: null, items: [biryani], charges: [{ kind: "discount", amount: null, percent: 50 }], total: null }), text)).toEqual({ ok: false, reason: "a percentage that wasn't said" });
    const ok = check(answer({ restaurant: null, items: [biryani], charges: [{ kind: "discount", amount: 50, percent: null }], total: null }), text);
    expect(ok.ok && ok.bill.discountAmount).toBe(5000);
  });

  it("throws it away for a dish that wasn't mentioned", () => {
    const extra = { name: "Garlic Naan", quantity: 1, price: 150, price_is: "line" as const, people: [] };
    expect(check(answer({ items: [...answer().items, extra] }))).toEqual({ ok: false, reason: "an item that wasn't said" });
  });

  it("drops a total or restaurant it made up, but keeps the rest", () => {
    const result = check(answer({ total: 840, restaurant: "Ganbei Restaurant" }));
    expect(result.ok && [result.bill.totalAmount, result.bill.merchant]).toEqual([null, null]);
  });

  it("fills in nobody for a dish when a person isn't in the group, and says so", () => {
    const pudding = { ...answer().items[1], people: ["Ravi"] };
    const result = check(answer({ items: [answer().items[0], pudding] }));
    expect(result.ok && result.bill.items[1].whoUnclear).toBe(true);
    expect(result.ok && result.bill.doubts).toEqual([`Coconut Pudding: couldn't tell who "Ravi" is, so nobody was filled in for it.`]);
  });

  it("flags a price made of two numbers ('2 25' as 225) for checking", () => {
    const text = "Avocado toast, 2 25 rupees, had by Sohil.";
    const result = check(answer({ restaurant: null, items: [{ name: "Avocado Toast", quantity: 1, price: 225, price_is: "line", people: ["Sohil"] }], charges: [], total: null }), text);
    expect(result.ok && result.bill.items[0].confidence).toBe("low");
    expect(result.ok && result.bill.doubts).toEqual(['Avocado Toast: heard "2 25" as 225. Check the price.']);
  });
});

describe("choosing between the rules and the model", () => {
  const clean = billFromSpeech("naan 80, dal 120", group);
  const muddled = billFromSpeech("naan 80, 90, dal", group);
  const model = billFromSpeech("naan 80, dal 90", group);

  it("never overrules a reading the rules had no trouble with, and doesn't ask", () => {
    expect(rulesNeedHelp(clean)).toBe(false);
    expect(chooseReading(clean, model).source).toBe("rules");
  });
  it("uses the model when the rules had trouble and it has less", () => {
    expect(rulesNeedHelp(muddled)).toBe(true);
    expect(chooseReading(muddled, model).source).toBe("model");
    expect(chooseReading(muddled, null).source).toBe("rules");
  });
});

describe("asking the model", () => {
  const reply = (content: unknown, status = 200) =>
    (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;

  it("returns nothing when there's no model, rather than failing", async () => {
    expect(await askModel(said, group, "Pi", { url: null })).toBeNull();
  });
  it("returns nothing for an error, an answer that isn't JSON, or the wrong shape", async () => {
    const url = "http://llm.test";
    expect(await askModel(said, group, "Pi", { url, fetchFn: reply("", 500), quiet: true })).toBeNull();
    expect(await askModel(said, group, "Pi", { url, fetchFn: reply("not json"), quiet: true })).toBeNull();
    expect(await askModel(said, group, "Pi", { url, fetchFn: reply(JSON.stringify({ items: "x" })), quiet: true })).toBeNull();
    const down = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    expect(await askModel(said, group, "Pi", { url, fetchFn: down, quiet: true })).toBeNull();
  });
  it("sends the group and what was said, and checks the answer", async () => {
    let sent = "";
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer()) } }] }));
    }) as unknown as typeof fetch;
    const bill = await billFromModel(said, group, "Pi", { url: "http://llm.test", fetchFn, quiet: true });
    expect(bill?.items).toHaveLength(2);
    expect(sent).toContain("Pi (the speaker), Sohil, Pytester 1, Pytester 2");
    expect(sent).toContain("watermelon juice");
    expect(JSON.parse(sent).temperature).toBe(0);
  });
});
