/**
 * Works out bill details from a spoken description: items with quantity and price, tax, tip,
 * service charge, discount and the total. "Two paneer tikka 250 each, naan 80, GST 5 percent,
 * total 800".
 *
 * Returns the same shape the receipt reader does, so the same review screen checks it. Nothing
 * is saved from speech: the person sees every number, and the check against a spoken total
 * catches a mis-heard price. Where it can't tell (is "2 naan 160" 160 each or 160 in all?) the
 * line is marked low-confidence and the line total is used, as on a printed receipt.
 */
import { readNumber, toPaise } from "./speech-numbers.js";
import { isPersonWord } from "./speech-split.js";

export interface SpokenItem {
  name: string;
  /** The whole line in paise (0 when no price was said). */
  price: number;
  quantity: number;
  confidence: "high" | "low";
  /** Who had it, as said ("shared by me and Bob"), for the split step to read. Empty when nothing was said. */
  who: string;
}

export interface SpokenBill {
  merchant: string | null;
  items: SpokenItem[];
  taxAmount: number | null;
  tipAmount: number | null;
  serviceFeeAmount: number | null;
  discountAmount: number | null;
  totalAmount: number | null;
  /** Plain notes for the review screen about anything not understood. */
  doubts: string[];
}

const FILLER = new Set(["rupees", "rupee", "rs", "inr", "at", "for", "of", "the", "a", "an", "x", "plates", "plate", "pieces", "piece", "pcs", "orders", "order", "is", "was", "it", "comes", "to", "costs", "cost", "price", "priced", "worth", "my", "we", "had", "got", "ordered", "have", "add", "added", "item", "items"]);
const EACH = new Set(["each", "apiece", "per", "every"]);
/** Words that start "who had it" ("curd shared by me", "thali only Bob"): not part of a dish's name. */
const WHO_HAD_IT = new Set(["shared", "split", "by", "only", "just", "between"]);
const TOTALISH = new Set(["total", "totalling", "totaling", "overall", "altogether", "amounting"]);
const TAX = new Set(["tax", "taxes", "gst", "vat", "cgst", "sgst", "igst"]);
const TIP = new Set(["tip", "tips", "gratuity"]);
const SERVICE = new Set(["service"]);
const DISCOUNT = new Set(["discount", "off", "coupon", "cashback"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[₹]/g, " ")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/[^\p{L}\p{N}\s.,%-]/gu, " ")
    .replace(/\b(hundred|thousand|lakh|lakhs|lac|lacs)\s+and\b/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
}

/** Splits on commas, full stops that aren't decimals, and joining words, but keeps "1,250" and "10.5". */
function segments(text: string): string[] {
  return text
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\b(hundred|thousand|lakh|lakhs|lac|lacs)\s+and\b/gi, "$1")
    .split(/\s*(?:;|,|\.(?!\d)|\b(?:and then|then|next|also|plus|and)\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Found {
  paise: number;
  whole: number;
  hundredths: number;
  start: number;
  length: number;
}

function numbersIn(tokens: string[]): Found[] {
  const found: Found[] = [];
  for (let i = 0; i < tokens.length; ) {
    const n = readNumber(tokens.map((t) => t.replace(/[.,]+$/, "")), i);
    const paise = n ? toPaise(n) : null;
    if (n && paise !== null) {
      found.push({ paise, whole: n.whole, hundredths: n.hundredths, start: i, length: n.length });
      i += n.length;
    } else {
      i++;
    }
  }
  return found;
}

/** A percentage of a total, in whole paise: `basisPoints` is hundredths of a percent. */
function percentOf(paise: number, basisPoints: number): number {
  return Math.floor((paise * basisPoints + 5000) / 10_000);
}

export function billFromSpeech(text: string, memberNames: string[] = []): SpokenBill {
  const bill: SpokenBill = { merchant: null, items: [], taxAmount: null, tipAmount: null, serviceFeeAmount: null, discountAmount: null, totalAmount: null, doubts: [] };
  const percentCharges: { field: "taxAmount" | "tipAmount" | "serviceFeeAmount" | "discountAmount"; basisPoints: number }[] = [];

  for (const segment of segments(text)) {
    const tokens = words(segment);
    if (tokens.length === 0) continue;
    const numbers = numbersIn(tokens);
    // "Only Bob" or "Bob, Cat" on its own is about the item just before it.
    const lastItem = bill.items[bill.items.length - 1];
    if (numbers.length === 0 && tokens.every((t) => WHO_HAD_IT.has(t) || t === "and" || isPersonWord(t, memberNames)) && tokens.some((t) => isPersonWord(t, memberNames))) {
      if (lastItem) lastItem.who = `${lastItem.who} ${tokens.join(" ")}`.trim();
      else bill.doubts.push(`Heard "${tokens.join(" ")}" before any item, so it wasn't used.`);
      continue;
    }
    const hasWord = (set: Set<string>) => tokens.some((t) => set.has(t));

    // Naming the bill: "bill name Ganbei", "at Ganbei".
    const nameAt = tokens.findIndex((t, i) => (t === "name" || t === "called" || t === "named") && i < tokens.length - 1);
    if (numbers.length === 0 && nameAt >= 0) {
      bill.merchant = tokens.slice(nameAt + 1).join(" ").replace(/\b\w/g, (c) => c.toUpperCase());
      continue;
    }

    // Charges and the total.
    const isTotal = hasWord(TOTALISH) && !hasWord(TAX) && !hasWord(TIP);
    const field: keyof Pick<SpokenBill, "taxAmount" | "tipAmount" | "serviceFeeAmount" | "discountAmount"> | null =
      hasWord(TAX) && !hasWord(SERVICE) ? "taxAmount"
      : hasWord(TIP) ? "tipAmount"
      : hasWord(SERVICE) ? "serviceFeeAmount"
      : hasWord(DISCOUNT) ? "discountAmount"
      : null;
    if (isTotal || field) {
      const amount = numbers[numbers.length - 1];
      if (!amount) {
        bill.doubts.push(`No amount was heard for "${tokens.join(" ")}".`);
        continue;
      }
      const isPercent = tokens[amount.start + amount.length] === "percent" || tokens[amount.start + amount.length] === "per";
      if (isTotal && !field) {
        bill.totalAmount = amount.paise;
      } else if (field && isPercent) {
        percentCharges.push({ field, basisPoints: amount.whole * 100 + amount.hundredths });
      } else if (field) {
        bill[field] = (bill[field] ?? 0) + amount.paise;
      }
      continue;
    }

    // Otherwise it's an item: "[quantity] name [for/at] price [each]".
    // A single number at the very start with a name after it is a quantity ("one veg biryani"), not a price.
    const onlyLeading = numbers.length === 1 && numbers[0].start === 0 && tokens.length > numbers[0].length;
    const price = numbers.length > 0 && !onlyLeading ? numbers[numbers.length - 1] : null;
    const leading = numbers.length > 0 && numbers[0].start === 0 && numbers[0] !== price ? numbers[0] : null;
    const nameTokens = tokens.filter((t, i) => {
      if (FILLER.has(t) || EACH.has(t) || t === "percent") return false;
      return !numbers.some((n) => i >= n.start && i < n.start + n.length);
    });
    if (nameTokens.length === 0) {
      bill.doubts.push(`Couldn't tell what "${tokens.join(" ")}" was.`);
      continue;
    }
    // "Curd shared by me" and "thali 140 Bob and Cat" are a dish plus who had it. The dish keeps its name.
    let whoAt = nameTokens.findIndex((t, i) => i > 0 && WHO_HAD_IT.has(t));
    if (whoAt < 0) {
      whoAt = nameTokens.length;
      while (whoAt > 1 && isPersonWord(nameTokens[whoAt - 1], memberNames)) whoAt--;
      if (whoAt === nameTokens.length) whoAt = -1;
    }
    const who = whoAt > 0 ? nameTokens.splice(whoAt).join(" ") : "";
    // "2 naan 160" has a leading quantity and one price. "naan 160" is one naan. A lone
    // leading number with no name after it is the price ("160 naan" is rare, so it stays a price).
    let quantity = 1;
    let priceFound = price;
    if (leading && leading.whole >= 1 && leading.hundredths === 0 && leading.whole <= 99 && price) quantity = leading.whole;
    else if (leading && !price) quantity = leading.whole >= 1 && leading.whole <= 99 ? leading.whole : 1;
    const each = tokens.some((t) => EACH.has(t));
    let lineTotal = priceFound ? priceFound.paise : 0;
    let confidence: "high" | "low" = "high";
    if (priceFound && each) lineTotal = priceFound.paise * quantity;
    else if (priceFound && quantity > 1 && !tokens.includes("for") && !tokens.some((t) => TOTALISH.has(t))) confidence = "low";
    if (!priceFound) confidence = "low";
    bill.items.push({
      name: nameTokens.join(" ").replace(/\b\w/g, (c) => c.toUpperCase()),
      price: lineTotal,
      quantity,
      confidence,
      who,
    });
  }

  // Percentages are of the items spoken so far, so they're worked out last.
  const subtotal = bill.items.reduce((sum, item) => sum + item.price, 0);
  for (const { field, basisPoints } of percentCharges) {
    if (subtotal === 0) {
      bill.doubts.push("A percentage was said before any item prices, so it was left out.");
      continue;
    }
    bill[field] = (bill[field] ?? 0) + percentOf(subtotal, basisPoints);
  }
  return bill;
}
