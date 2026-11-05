/**
 * A small language model on the Pi that reads a spoken bill (the `llm` container, llama.cpp).
 * It's better than the rules at loose phrasing, but it's a model, so nothing it says is taken
 * on trust:
 *
 * - Every price, percentage, quantity and total must be a number that was actually said. One
 *   that wasn't means the whole answer is thrown away and the rules' reading is used.
 * - People are names it read; they're matched to the group here, the same way as the rules.
 * - The restaurant's name must be words that were said.
 * - All arithmetic is done here in whole paise, never by the model.
 *
 * Like the other local services it never throws. Down, slow, or a bad answer all mean "use the
 * rules". What was said is never logged.
 */
import { z } from "zod";
import { spokenAmounts, spokenPercents, spokenWords, type SpokenBill, type SpokenItem } from "./speech-bill.js";
import { isPersonWord } from "./speech-split.js";
import { matchPersonSpan } from "./speech-names.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_CACHE_MS = 10_000;

/** LLM_URL turns the model on. Unset (as on Render) means the rules alone. */
export function llmUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.LLM_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

function timeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.LLM_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1000 && value <= 120_000 ? value : DEFAULT_TIMEOUT_MS;
}

export interface LlmDeps {
  url?: string | null;
  /** Don't log failures (warming up). */
  quiet?: boolean;
  /** Which model to ask for. llama.cpp serves one model and ignores it; Ollama, for local testing, needs it. */
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

let healthCache: { at: number; ok: boolean } | null = null;

export async function llmAvailable(deps: LlmDeps = {}): Promise<boolean> {
  const url = deps.url === undefined ? llmUrl() : deps.url;
  if (!url) return false;
  if (!deps.fetchFn && healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) return healthCache.ok;
  let ok = false;
  try {
    const res = await (deps.fetchFn ?? fetch)(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (!deps.fetchFn) healthCache = { at: Date.now(), ok };
  return ok;
}

/** What the model is asked to fill in. Constrained decoding makes it valid JSON of this shape. */
const answerJsonSchema = {
  type: "object",
  properties: {
    restaurant: { type: ["string", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "integer", minimum: 1, maximum: 99 },
          price: { type: ["number", "null"] },
          price_is: { type: "string", enum: ["each", "line"] },
          people: { type: "array", items: { type: "string" } },
        },
        required: ["name", "quantity", "price", "price_is", "people"],
      },
    },
    charges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["tax", "tip", "service", "discount"] },
          amount: { type: ["number", "null"] },
          percent: { type: ["number", "null"] },
        },
        required: ["kind", "amount", "percent"],
      },
    },
    total: { type: ["number", "null"] },
  },
  required: ["restaurant", "items", "charges", "total"],
} as const;

const answerSchema = z.object({
  restaurant: z.string().max(120).nullable(),
  items: z
    .array(
      z.object({
        name: z.string().max(120),
        quantity: z.number().int().min(1).max(99),
        price: z.number().min(0).max(1_000_000).nullable(),
        price_is: z.enum(["each", "line"]),
        people: z.array(z.string().max(80)).max(20),
      }),
    )
    .max(60),
  charges: z
    .array(z.object({ kind: z.enum(["tax", "tip", "service", "discount"]), amount: z.number().min(0).max(1_000_000).nullable(), percent: z.number().min(0).max(100).nullable() }))
    .max(10),
  total: z.number().min(0).max(1_000_000).nullable(),
});
export type ModelAnswer = z.infer<typeof answerSchema>;

/** Kept the same for every request, so the server caches it and only reads it once. */
const INSTRUCTIONS = `You read a restaurant bill that someone described out loud, from a speech-to-text transcript, and fill in JSON.

Rules:
- items: one entry per dish or drink. name is the dish name only, without people's names, prices or words like "shared by".
- quantity: how many were ordered, 1 if not said.
- price: copy the number that was said for that dish, as a number of rupees. null if no price was said for it. Never calculate or guess a price.
- price_is: "each" if the price is for one unit ("150 each", "150 per plate"), otherwise "line".
- Transcripts sometimes split one number in two: "2 25 rupees" after a dish means 225.
- people: who had that dish. "me" for the speaker (I, me, myself, mine), "everyone" for everyone/all of us/all shared. Anyone else: copy their words exactly as written in the transcript, even if spelled oddly ("pi tester 1"). A number right after a name is part of the name, not a price. Only people said for that dish; empty if nobody was said.
- charges: tax/GST, tip, service charge, discount. amount in rupees, or percent if a percentage was said.
- total: the bill total if said, else null.
- restaurant: the restaurant or bill name if said ("we ate at X", "restaurant X", "bill name X"), else null.

Example. Group: Asha (the speaker), Ravi, Team Lead 2.
Said: "Dinner at Ganbei. Two naan, 80 each, shared by me and ravie. Paneer tikka 300 had by team lead two. Lassi 90 that everyone shared. GST 5 percent. Total 600."
JSON: {"restaurant":"Ganbei","items":[{"name":"Naan","quantity":2,"price":80,"price_is":"each","people":["me","ravie"]},{"name":"Paneer Tikka","quantity":1,"price":300,"price_is":"line","people":["team lead two"]},{"name":"Lassi","quantity":1,"price":90,"price_is":"line","people":["everyone"]}],"charges":[{"kind":"tax","amount":null,"percent":5}],"total":600}`;

function userMessage(text: string, memberNames: string[], speakerName: string | null): string {
  const group =
    memberNames.length > 0
      ? `Group: ${memberNames.map((name) => (name === speakerName ? `${name} (the speaker)` : name)).join(", ")}.`
      : "Group: not chosen yet, so copy names as said.";
  return `${group}\nSaid: "${text.replace(/"/g, "'")}"\nJSON:`;
}

const WARM_EVERY_MS = 10 * 60 * 1000;
let warmedAt = 0;

/**
 * Has the model read its instructions once, in the background, so the first person to speak a
 * bill after a restart doesn't wait for that too. Called when someone opens a screen with a mic.
 * Never throws and never waits.
 */
export function warmModel(deps: LlmDeps = {}): void {
  const url = deps.url === undefined ? llmUrl() : deps.url;
  if (!url || Date.now() - warmedAt < WARM_EVERY_MS) return;
  warmedAt = Date.now();
  void (async () => {
    if (!(await llmAvailable(deps))) {
      warmedAt = 0;
      return;
    }
    const answer = await askModel("naan 80", [], null, { ...deps, quiet: true });
    if (!answer) warmedAt = 0;
  })();
}

/** Asks the model. Returns its answer, or null for any failure. */
export async function askModel(text: string, memberNames: string[], speakerName: string | null, deps: LlmDeps = {}): Promise<ModelAnswer | null> {
  const url = deps.url === undefined ? llmUrl() : deps.url;
  if (!url) return null;
  const started = Date.now();
  try {
    const res = await (deps.fetchFn ?? fetch)(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...((deps.model ?? process.env.LLM_MODEL) ? { model: deps.model ?? process.env.LLM_MODEL } : {}),
        messages: [
          { role: "system", content: INSTRUCTIONS },
          { role: "user", content: userMessage(text, memberNames, speakerName) },
        ],
        temperature: 0,
        max_tokens: 900,
        cache_prompt: true,
        // Thinking would only slow it down. llama.cpp takes the first; Ollama (local testing, where a model is named) the second.
        chat_template_kwargs: { enable_thinking: false },
        ...((deps.model ?? process.env.LLM_MODEL) ? { reasoning_effort: "none" } : {}),
        response_format: { type: "json_schema", json_schema: { name: "bill", schema: answerJsonSchema } },
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? timeoutMs()),
    });
    if (!res.ok) throw new Error(`model answered ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("model gave no answer");
    const parsed = answerSchema.safeParse(JSON.parse(content));
    if (!parsed.success) throw new Error("model's answer wasn't the expected shape");
    // How long it took, to judge the model's speed on the Pi. Never what was said.
    if (!deps.quiet) console.info(`Language model read a spoken bill in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    return parsed.data;
  } catch (err) {
    if (!deps.quiet) console.error("Language model failed:", err instanceof Error ? err.message : "unknown error");
    return null;
  }
}

const SPEAKER = new Set(["me", "i", "myself", "mine", "speaker"]);
const EVERYONE = new Set(["everyone", "everybody", "all", "all of us"]);

/** Whether a name the model gave is someone: "me", "everyone", or a member (heard however). */
function knownPerson(said: string, memberNames: string[], speakerName: string | null): boolean {
  const lower = said.toLowerCase().trim();
  if (SPEAKER.has(lower) || EVERYONE.has(lower)) return true;
  if (speakerName && lower === speakerName.toLowerCase()) return true;
  if (memberNames.some((name) => name.toLowerCase() === lower)) return true;
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const span = matchPersonSpan(words, 0, memberNames);
  if (span && span.length === words.length && span.indexes.length === 1) return true;
  return words.length === 1 && isPersonWord(words[0], memberNames);
}

/** A rupee amount from the model, as whole paise. Only ever compared with what was said. */
const toPaise = (rupees: number) => Math.round(rupees * 100);

export type CheckedAnswer = { ok: true; bill: SpokenBill } | { ok: false; reason: string };

/**
 * Holds the model's answer to what was said. Every number must have been said; anything that
 * doesn't add up throws the whole answer away. Returns the same shape the rules do, with `who`
 * written so the split step reads it the same way.
 */
export function checkAnswer(answer: ModelAnswer, text: string, memberNames: string[], speakerName: string | null): CheckedAnswer {
  const amounts = spokenAmounts(text, memberNames);
  const percents = spokenPercents(text);
  const said = (paise: number) => amounts.has(paise);
  const words = new Set(spokenWords(text));
  const bill: SpokenBill = { merchant: null, items: [], taxAmount: null, tipAmount: null, serviceFeeAmount: null, discountAmount: null, totalAmount: null, doubts: [] };

  if (answer.items.length === 0) return { ok: false, reason: "no items" };
  for (const item of answer.items) {
    const name = item.name.replace(/\s+/g, " ").trim();
    const nameWords = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
    // A dish nobody mentioned.
    if (!name || (nameWords.length > 0 && !nameWords.some((w) => words.has(w) || words.has(`${w}s`) || words.has(w.replace(/s$/, ""))))) {
      return { ok: false, reason: "an item that wasn't said" };
    }
    if (item.quantity > 1 && !said(item.quantity * 100)) return { ok: false, reason: "a quantity that wasn't said" };
    let line = 0;
    let confidence: SpokenItem["confidence"] = "high";
    if (item.price !== null && item.price > 0) {
      const each = toPaise(item.price);
      if (!said(each)) return { ok: false, reason: "a price that wasn't said" };
      line = item.price_is === "each" ? each * item.quantity : each;
      if (item.price_is === "line" && item.quantity > 1) confidence = "low";
      const heard = amounts.get(each);
      if (heard) {
        confidence = "low";
        bill.doubts.push(`${titleCase(name)}: heard "${heard}" as ${each / 100}. Check the price.`);
      }
    } else {
      confidence = "low";
    }
    const people = item.people.map((p) => p.trim()).filter(Boolean);
    const unknown = people.find((p) => !knownPerson(p, memberNames, speakerName));
    const spoken: SpokenItem = { name: titleCase(name), price: line, quantity: item.quantity, confidence, who: people.join(" and ") };
    if (memberNames.length > 0 && unknown !== undefined) {
      spoken.whoUnclear = true;
      bill.doubts.push(`${spoken.name}: couldn't tell who "${unknown}" is, so nobody was filled in for it.`);
    }
    bill.items.push(spoken);
  }

  const subtotal = bill.items.reduce((sum, item) => sum + item.price, 0);
  const field = { tax: "taxAmount", tip: "tipAmount", service: "serviceFeeAmount", discount: "discountAmount" } as const;
  for (const charge of answer.charges) {
    if (charge.percent !== null && charge.percent > 0) {
      const basisPoints = Math.round(charge.percent * 100);
      if (!percents.has(basisPoints)) return { ok: false, reason: "a percentage that wasn't said" };
      if (subtotal === 0) {
        bill.doubts.push("A percentage was said before any item prices, so it was left out.");
        continue;
      }
      bill[field[charge.kind]] = (bill[field[charge.kind]] ?? 0) + Math.floor((subtotal * basisPoints + 5000) / 10_000);
    } else if (charge.amount !== null && charge.amount > 0) {
      const paise = toPaise(charge.amount);
      // "GST 5 percent" read as ₹5.
      if (percents.has(paise) && !answer.charges.some((other) => other !== charge && other.percent !== null)) return { ok: false, reason: "a percentage read as an amount" };
      if (!said(paise)) return { ok: false, reason: "a charge that wasn't said" };
      bill[field[charge.kind]] = (bill[field[charge.kind]] ?? 0) + paise;
    }
  }
  // A total it added up itself is only dropped: it's the check, so it must be the one said.
  if (answer.total !== null && answer.total > 0 && said(toPaise(answer.total))) bill.totalAmount = toPaise(answer.total);

  // The restaurant's name must be words that were said; otherwise it's left blank.
  const restaurant = answer.restaurant?.replace(/\s+/g, " ").trim();
  if (restaurant) {
    const restaurantWords = restaurant.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (restaurantWords.every((w) => words.has(w))) bill.merchant = titleCase(restaurant);
  }
  return { ok: true, bill };
}

const titleCase = (text: string) => text.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, space: string, c: string) => space + c.toUpperCase());

/** Items + charges - discount, against the total that was said. Null when no total was said. */
function addsUp(bill: SpokenBill): boolean | null {
  if (bill.totalAmount === null) return null;
  const items = bill.items.reduce((sum, item) => sum + item.price, 0);
  const sum = items + (bill.taxAmount ?? 0) + (bill.tipAmount ?? 0) + (bill.serviceFeeAmount ?? 0) - (bill.discountAmount ?? 0);
  // Spoken totals are often rounded to the rupee.
  return Math.abs(sum - bill.totalAmount) < 100;
}

/**
 * How much of a reading the person would have to fix: doubts, unpriced items, unknown people, a
 * total that's off, and dish names so long they're probably several things run together.
 */
export function trouble(bill: SpokenBill): number {
  if (bill.items.length === 0) return 100;
  return (
    bill.doubts.length +
    bill.items.filter((item) => item.price === 0).length +
    bill.items.filter((item) => item.name.split(" ").length > 4).length +
    bill.items.filter((item) => item.whoUnclear).length +
    (addsUp(bill) === false ? 2 : 0)
  );
}

/** The rules are trusted when they had no trouble; the model is only asked otherwise. */
export function rulesNeedHelp(rules: SpokenBill): boolean {
  return trouble(rules) > 0;
}

/**
 * The model's reading when the rules had trouble and it has less, else the rules'. The rules are
 * predictable and tested, so a clean reading of theirs is never overruled.
 */
export function chooseReading(rules: SpokenBill, model: SpokenBill | null): { bill: SpokenBill; source: "model" | "rules" } {
  if (!model || !rulesNeedHelp(rules)) return { bill: rules, source: "rules" };
  return trouble(model) < trouble(rules) ? { bill: model, source: "model" } : { bill: rules, source: "rules" };
}

/** The model's reading of a spoken bill, checked, or null when it's off, failed or wasn't believable. */
export async function billFromModel(text: string, memberNames: string[], speakerName: string | null, deps: LlmDeps = {}): Promise<SpokenBill | null> {
  const answer = await askModel(text, memberNames, speakerName, deps);
  if (!answer) return null;
  const checked = checkAnswer(answer, text, memberNames, speakerName);
  if (!checked.ok) {
    console.error(`Language model's answer was set aside: ${checked.reason}.`);
    return null;
  }
  return checked.bill;
}
