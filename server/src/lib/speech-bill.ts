/**
 * Works out bill details from a spoken description: items with quantity and price, tax, tip,
 * service charge, discount, the total and the restaurant. "Two paneer tikka 250 each, naan 80,
 * GST 5 percent, total 800".
 *
 * Returns the same shape the receipt reader does, so the same review screen checks it. Nothing
 * is saved from speech: the person sees every number, and the check against a spoken total
 * catches a mis-heard price. Where it can't tell (is "2 naan 160" 160 each or 160 in all?) the
 * line is marked low-confidence and the line total is used, as on a printed receipt.
 *
 * Speech recognition punctuates as people pause, so "2 watermelon juice, 150 each, shared by me
 * and Sohil." is one item. The text is cut at every comma, full stop and "and", and then each
 * piece is put back with the item it belongs to: a piece that is only a price, or only people,
 * belongs to the item before it.
 */
import { readNumber, toPaise, isNumberWord } from "./speech-numbers.js";
import { isPersonWord, splitFromSpeech, type SpeechMember } from "./speech-split.js";
import { matchPersonSpan } from "./speech-names.js";

export interface SpokenItem {
  name: string;
  /** The whole line in paise (0 when no price was said). */
  price: number;
  quantity: number;
  confidence: "high" | "low";
  /** Who had it, as said ("shared by me and Bob"), for the split step to read. Empty when nothing was said. */
  who: string;
  /** Set when a name said for it isn't anyone in the group, so no one should be filled in. */
  whoUnclear?: boolean;
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

const FILLER = new Set(["rupees", "rupee", "rs", "inr", "only", "at", "for", "of", "the", "a", "an", "x", "plates", "plate", "pieces", "piece", "pcs", "orders", "order", "is", "was", "it", "comes", "to", "costs", "cost", "price", "priced", "worth", "my", "we", "had", "got", "ordered", "have", "add", "added", "item", "items", "one's", "ones", "that", "which", "who"]);
/** Words people say while thinking, which are never part of a bill. */
const DISCOURSE = new Set(["okay", "ok", "so", "um", "umm", "uh", "uhh", "hmm", "yeah", "alright", "well", "like", "basically", "actually"]);
const CURRENCY = new Set(["rupees", "rupee", "rs", "inr", "bucks", "only"]);
const EACH = new Set(["each", "apiece", "per", "every"]);
/** Words that start "who had it" ("curd shared by me", "thali only Bob", "had by Sohil"). */
const WHO_CUE = new Set(["shared", "share", "split", "by", "only", "just", "between", "among", "amongst", "for"]);
/** Words that can sit inside "who had it" without being anyone. */
const WHO_GLUE = new Set(["shared", "share", "split", "by", "only", "just", "between", "among", "amongst", "with", "equally", "and", "had", "for", "of", "us", "all", "the"]);
const SPEAKER = new Set(["me", "i", "myself", "mine"]);
const EVERYONE = new Set(["everyone", "everybody", "all"]);
const TOTALISH = new Set(["total", "totalling", "totaling", "overall", "altogether", "amounting"]);
const TAX = new Set(["tax", "taxes", "gst", "vat", "cgst", "sgst", "igst"]);
const TIP = new Set(["tip", "tips", "gratuity"]);
const SERVICE = new Set(["service"]);
const DISCOUNT = new Set(["discount", "off", "coupon", "cashback"]);
const HARD_BREAK = new Set([".", ";", "!", "?", "then", "next", "also", "plus"]);
const SOFT_BREAK = new Set([",", "and"]);
/** Words that can come before "at Ganbei" in "we had dinner at Ganbei". */
const MERCHANT_LEAD = new Set(["at", "we", "i", "ate", "eat", "eating", "were", "was", "had", "have", "dinner", "lunch", "breakfast", "brunch", "snacks", "drinks", "went", "go", "to", "the", "bill", "order", "ordered", "food", "this", "is", "it", "out", "from", "our", "today", "tonight", "yesterday"]);
const PLACE_WORDS = new Set(["restaurant", "hotel", "dhaba"]);

/** A word of the spoken text. People named by more than one word ("pi tester 1") are one token. */
interface Tok {
  w: string;
  /** The words as said, when this token is a person. */
  person?: string;
  /** Set when two numbers were read as one ("2 25 rupees" as 225). */
  joined?: string;
}

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/(\d),(?=\d{3}\b)/g, "$1") // 1,250
      .replace(/\b(rs|inr)\./g, "$1 ")
      .replace(/₹\s*/g, " ")
      .replace(/(\d)\s*\/-/g, "$1 ")
      .replace(/(\d)\s*%/g, "$1 percent")
      .replace(/\b(hundred|thousand|lakh|lakhs|lac|lacs)\s+and\b/g, "$1")
      .replace(/[-–—]/g, " ")
      .match(/\d+(?:\.\d{1,2})?|[\p{L}\p{N}']+|[,.;!?]/gu) ?? []
  ).filter((w) => !DISCOURSE.has(w));
}

const isNumberTok = (t: Tok) => !t.person && isNumberWord(t.w);

function isPersonTok(t: Tok, names: string[]): boolean {
  return !!t.person || SPEAKER.has(t.w) || EVERYONE.has(t.w) || (names.length > 0 && isPersonWord(t.w, names));
}

/** Runs several words that name one person ("pi tester 1") into one token, so "1" isn't a price. */
function markPeople(words: string[], names: string[]): Tok[] {
  const tokens: Tok[] = [];
  for (let i = 0; i < words.length; i++) {
    const span = names.length > 0 ? matchPersonSpan(words, i, names) : null;
    if (span) {
      const said = words.slice(i, i + span.length).join(" ");
      tokens.push({ w: said, person: said });
      i += span.length - 1;
    } else {
      tokens.push({ w: words[i] });
    }
  }
  return tokens;
}

/**
 * Speech recognition writes "two twenty-five" as "2 25". After a dish's name, a single digit
 * then two digits, with "rupees" or the end after them, is read as one price. It's flagged so
 * the person checks it.
 */
function joinSplitPrices(tokens: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    const before = [...out].reverse().find((p) => p.w !== ",");
    const nameBefore = before !== undefined && !before.person && !isNumberTok(before) && /\p{L}/u.test(before.w) && !FILLER.has(before.w) && !WHO_CUE.has(before.w);
    const endsPrice = after === undefined || CURRENCY.has(after.w) || EACH.has(after.w) || HARD_BREAK.has(after.w) || SOFT_BREAK.has(after.w);
    if (!t.person && /^[1-9]$/.test(t.w) && next && !next.person && /^\d{2}$/.test(next.w) && nameBefore && endsPrice) {
      out.push({ w: `${t.w}${next.w}`, joined: `${t.w} ${next.w}` });
      i++;
    } else {
      out.push(t);
    }
  }
  return out;
}

interface Piece {
  tokens: Tok[];
  /** What came before it: a comma or "and" (soft), or a full stop or "then" (hard). */
  after: "soft" | "hard" | "start";
  /** It came straight after "and". */
  afterAnd: boolean;
}

function cut(tokens: Tok[]): Piece[] {
  const pieces: Piece[] = [];
  let current: Tok[] = [];
  let after: Piece["after"] = "start";
  let afterAnd = false;
  for (const t of tokens) {
    const hard = !t.person && HARD_BREAK.has(t.w);
    const soft = !t.person && SOFT_BREAK.has(t.w);
    if (hard || soft) {
      if (current.length > 0) {
        pieces.push({ tokens: current, after, afterAnd });
        current = [];
        after = hard ? "hard" : "soft";
      } else if (hard) {
        // A full stop and an "and" together still end a sentence.
        after = "hard";
      } else if (after === "start") {
        after = "soft";
      }
      afterAnd = t.w === "and";
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) pieces.push({ tokens: current, after, afterAnd });
  return pieces;
}

interface Found {
  paise: number;
  whole: number;
  hundredths: number;
  start: number;
  length: number;
}

function numbersIn(tokens: Tok[]): Found[] {
  const words = tokens.map((t) => (t.person ? "\u0000" : t.w));
  const found: Found[] = [];
  for (let i = 0; i < words.length; ) {
    const n = readNumber(words, i);
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

const titleCase = (words: string[]) => words.join(" ").replace(/(^|\s)(\p{L})/gu, (_m, space: string, c: string) => space + c.toUpperCase());

/** Words after which an unknown word is someone's name: "shared by Ravi", "split between Ravi". */
const LINK = new Set(["by", "between", "among", "amongst", "with"]);
/** Verbs that end "who had it" when the people come first: "everyone shared". */
const AFTER_PEOPLE = new Set(["shared", "split", "had", "took", "ate", "drank", "got"]);
const SINGLE_DIGIT = /^(?:[1-9]|one|two|three|four|five|six|seven|eight|nine)$/;

/** A word that isn't anyone known but stands where a name would. */
const nameLike = (t: Tok | undefined) =>
  t !== undefined && !t.person && /^\p{L}+$/u.test(t.w) && !isNumberWord(t.w) && !EACH.has(t.w) && !FILLER.has(t.w) && !WHO_GLUE.has(t.w) && !CURRENCY.has(t.w) && !SPEAKER.has(t.w) && !EVERYONE.has(t.w) && t.w !== "percent";

interface WhoSpan {
  start: number;
  end: number;
  /** Words taken as names that aren't anyone in the group (or every name, with no group). */
  unknown: string[];
}

/**
 * Where "who had it" starts in a piece, and where it ends. "Coconut pudding 500 split by pi
 * tester 1" -> the people are from "split" on. "Curd shared by me 50" -> "shared by me", and the
 * 50 is still the curd's price. A word that isn't a known person counts as a name only where a
 * name has to be: after "by", "between" or "with", or as the last word after "only".
 */
function whoSpan(tokens: Tok[], names: string[]): WhoSpan | null {
  // People named before the verb: "everyone shared", "Sohil and I split", "Ravi had".
  for (let c = 0; c < tokens.length; c++) {
    if (!isPersonTok(tokens[c], names) || (c > 0 && isPersonTok(tokens[c - 1], names))) continue;
    let end = c;
    while (end < tokens.length && (isPersonTok(tokens[end], names) || (!tokens[end].person && tokens[end].w === "and"))) end++;
    const verb = tokens[end];
    if (verb && !verb.person && AFTER_PEOPLE.has(verb.w) && isPersonTok(tokens[end - 1], names)) {
      return { start: c, end: end + 1, unknown: [] };
    }
  }
  for (let c = 0; c < tokens.length; c++) {
    const cue = tokens[c];
    if (cue.person || !WHO_CUE.has(cue.w)) continue;
    let end = c;
    let people = 0;
    let linked = false;
    const unknown: string[] = [];
    for (let i = c; i < tokens.length; i++) {
      const t = tokens[i];
      const next = tokens[i + 1];
      if (isPersonTok(t, names)) {
        people++;
        end = i + 1;
      } else if (!t.person && WHO_GLUE.has(t.w)) {
        if (LINK.has(t.w)) linked = true;
        end = i + 1;
      } else if (i > c && nameLike(t) && (linked || ((cue.w === "only" || cue.w === "just") && (next === undefined || isNumberTok(next))))) {
        // "pytester 2", "pi tester one": a single digit straight after a name is part of it.
        let said = t.w;
        end = i + 1;
        while (nameLike(tokens[end]) && linked) said += ` ${tokens[end++].w}`;
        if (tokens[end] && SINGLE_DIGIT.test(tokens[end].w) && !tokens[end].person) said += ` ${tokens[end++].w}`;
        unknown.push(said);
        i = end - 1;
      } else {
        break;
      }
    }
    // "for sixty", "only 50", "split pea soup": a cue word that no person follows isn't about people.
    if (people > 0 || (unknown.length > 0 && unknown.length <= 3)) {
      // Trailing glue ("shared by me and") isn't part of it.
      while (end > c && !tokens[end - 1].person && !isPersonTok(tokens[end - 1], names) && WHO_GLUE.has(tokens[end - 1].w)) end--;
      return { start: c, end, unknown };
    }
  }
  return null;
}

/** Who had it, as words for the split step. "Everyone shared" and "Sohil had" lose the verb, which says nothing more. */
const whoText = (tokens: Tok[], names: string[]) =>
  tokens
    .filter((t, i) => !(i === 0 && t.w === "for") && !(i > 0 && !t.person && AFTER_PEOPLE.has(t.w) && isPersonTok(tokens[i - 1], names)))
    .map((t) => t.person ?? t.w)
    .join(" ");

type Kind = "charge" | "merchant" | "who" | "price" | "item";

interface Draft {
  tokens: Tok[];
  who: Tok[];
  /** Names said for it that aren't anyone in the group. */
  unknown: string[];
}

export function billFromSpeech(text: string, memberNames: string[] = []): SpokenBill {
  const bill: SpokenBill = { merchant: null, items: [], taxAmount: null, tipAmount: null, serviceFeeAmount: null, discountAmount: null, totalAmount: null, doubts: [] };
  const percentCharges: { field: "taxAmount" | "tipAmount" | "serviceFeeAmount" | "discountAmount"; basisPoints: number }[] = [];
  const names = memberNames;

  const pieces = cut(joinSplitPrices(markPeople(tokenize(text), names)));
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  /** The last piece ended while naming people, so a bare word after "and" is probably another one. */
  let inWho = false;

  for (const piece of pieces) {
    const tokens = piece.tokens;
    const has = (set: Set<string>) => tokens.some((t) => !t.person && set.has(t.w));
    const numbers = numbersIn(tokens);
    const plainWords = tokens.filter((t) => !t.person && !isNumberTok(t) && !FILLER.has(t.w) && !EACH.has(t.w) && !CURRENCY.has(t.w) && t.w !== "percent");

    let kind: Kind;
    const isTotal = has(TOTALISH) && !has(TAX) && !has(TIP);
    const charge = has(TAX) && !has(SERVICE) ? "taxAmount" : has(TIP) ? "tipAmount" : has(SERVICE) ? "serviceFeeAmount" : has(DISCOUNT) ? "discountAmount" : null;
    const merchant = numbers.length === 0 ? merchantIn(tokens) : null;
    const span = whoSpan(tokens, names);
    const onlyPeople =
      tokens.length > 0 &&
      isPersonTok(tokens[0], names) &&
      tokens.every((t) => isPersonTok(t, names) || (!t.person && (WHO_GLUE.has(t.w) || AFTER_PEOPLE.has(t.w) || SINGLE_DIGIT.test(t.w))));
    // "Sohil" on its own after "shared by me and": another person, even before the group is known.
    // "Sohil" or "pytester 1" on its own after "shared by me and": another person, even one the group doesn't have.
    const anotherName =
      inWho && piece.afterAnd && tokens.length <= 3 && nameLike(tokens[0]) &&
      tokens.slice(1).every((t, i) => nameLike(t) || (i === tokens.length - 2 && SINGLE_DIGIT.test(t.w)));
    // "Had by Sohil": glue, then the people.
    const whoFirst = span !== null && tokens.slice(0, span.start).every((t) => !t.person && WHO_GLUE.has(t.w));

    if (isTotal || charge) kind = "charge";
    else if (merchant) kind = "merchant";
    else if (onlyPeople || anotherName || whoFirst) kind = "who";
    else if (numbers.length > 0 && plainWords.length === 0) kind = "price";
    else kind = "item";

    if (kind === "charge") {
      inWho = false;
      const words = tokens.map((t) => t.w);
      const amount = numbers[numbers.length - 1];
      if (!amount) {
        bill.doubts.push(`No amount was heard for "${words.join(" ")}".`);
        continue;
      }
      const nextWord = words[amount.start + amount.length];
      const isPercent = nextWord === "percent" || nextWord === "per";
      if (isTotal && !charge) bill.totalAmount = amount.paise;
      else if (charge && isPercent) percentCharges.push({ field: charge, basisPoints: amount.whole * 100 + amount.hundredths });
      else if (charge) bill[charge] = (bill[charge] ?? 0) + amount.paise;
      continue;
    }

    if (kind === "merchant") {
      inWho = false;
      bill.merchant = merchant;
      continue;
    }

    if (kind === "who") {
      // "Shared by me 50": the people, then the price of the item they're about.
      const end = !onlyPeople && whoFirst && span ? span.end : tokens.length;
      const people = tokens.slice(0, end);
      const rest = tokens.slice(end);
      if (current) {
        current.who.push(...people);
        if (whoFirst && span) current.unknown.push(...span.unknown);
        else if (anotherName) current.unknown.push(tokens.map((t) => t.w).join(" "));
        if (rest.length > 0) current.tokens.push(...rest);
      } else {
        bill.doubts.push(`Heard "${whoText(people, names)}" before any item, so it wasn't used.`);
      }
      inWho = rest.length === 0;
      continue;
    }

    if (kind === "price") {
      inWho = false;
      const held = current ? numbersIn(current.tokens) : [];
      const hasNoPrice =
        held.length === 0 ||
        (held.length === 1 && held[0].whole >= 1 && held[0].whole <= 99 && held[0].hundredths === 0 &&
          (held[0].start === 0 || tokens.some((t) => EACH.has(t.w))));
      if (current && hasNoPrice) {
        current.tokens.push(...tokens);
      } else {
        bill.doubts.push(`Couldn't tell what "${tokens.map((t) => t.w).join(" ")}" was.`);
      }
      continue;
    }

    // An item, maybe with who had it in the same breath: "coconut pudding 500 split by pi tester 1".
    let itemTokens = tokens;
    let who: Tok[] = [];
    let unknown: string[] = [];
    if (span && span.start > 0) {
      who = tokens.slice(span.start, span.end);
      unknown = span.unknown;
      itemTokens = [...tokens.slice(0, span.start), ...tokens.slice(span.end)];
      inWho = span.end === tokens.length;
    } else {
      // "Thali 140 Bob and Cat": names at the end are who had it.
      let at = itemTokens.length;
      while (at > 1 && isPersonTok(itemTokens[at - 1], names) && !(EVERYONE.has(itemTokens[at - 1].w) && at - 1 === 0)) at--;
      if (at < itemTokens.length && plainWords.some((t) => !isPersonTok(t, names))) {
        who = itemTokens.slice(at);
        itemTokens = itemTokens.slice(0, at);
        inWho = true;
      } else {
        inWho = false;
      }
    }
    // "Mac and cheese 300": a name with no number, then "and", then the rest of the same dish.
    const previous: Draft | null = current;
    const previousBare = previous !== null && piece.afterAnd && previous.who.length === 0 && numbersIn(previous.tokens).length === 0 && drafts[drafts.length - 1] === previous;
    if (previous && previousBare && numbers.length > 0 && numbers[0].start > 0) {
      previous.tokens.push({ w: "and" }, ...itemTokens);
      previous.who.push(...who);
      previous.unknown.push(...unknown);
      continue;
    }
    current = { tokens: itemTokens, who, unknown };
    drafts.push(current);
  }

  for (const draft of drafts) {
    const item = readItem(draft.tokens, bill);
    if (!item) continue;
    // "I had one, Sohil had one" on three burgers: one each is an equal split. Other counts
    // would need units per person, so they're left for the person to fill in.
    const counts = draft.who.filter((t) => !t.person && SINGLE_DIGIT.test(t.w));
    if (names.length > 0 && counts.length > 0) {
      const people = draft.who.filter((t) => isPersonTok(t, names)).length;
      if (counts.every((t) => t.w === "1" || t.w === "one") && people === item.quantity) {
        draft.who = draft.who.filter((t) => !counts.includes(t));
      } else {
        item.whoUnclear = true;
        bill.doubts.push(`${item.name}: couldn't tell who had how many, so nobody was filled in for it.`);
      }
    }
    item.who = whoText(draft.who, names);
    // With the group known, a name that isn't in it can't be filled in, and guessing around it would be wrong.
    if (names.length > 0 && draft.unknown.length > 0) {
      item.whoUnclear = true;
      bill.doubts.push(`${item.name}: couldn't tell who "${draft.unknown[0]}" is, so nobody was filled in for it.`);
    }
    bill.items.push(item);
  }

  // Percentages are of the items spoken, so they're worked out last.
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

/** "[quantity] name [for/at] price [each]". */
function readItem(tokens: Tok[], bill: SpokenBill): SpokenItem | null {
  const words = tokens.map((t) => t.w);
  const numbers = numbersIn(tokens);
  // A single number at the very start with a name after it is a quantity ("one veg biryani"), not a price.
  const onlyLeading = numbers.length === 1 && numbers[0].start === 0 && tokens.length > numbers[0].length;
  const price = numbers.length > 0 && !onlyLeading ? numbers[numbers.length - 1] : null;
  const leading = numbers.length > 0 && (numbers[0].start === 0 || numbers.length >= 2) && numbers[0] !== price ? numbers[0] : null;
  const nameWords = tokens
    .filter((t, i) => {
      if (t.person || FILLER.has(t.w) || EACH.has(t.w) || t.w === "percent") return false;
      return !numbers.some((n) => i >= n.start && i < n.start + n.length);
    })
    .map((t) => t.w);
  if (nameWords.length === 0) {
    if (words.length > 0) bill.doubts.push(`Couldn't tell what "${words.join(" ")}" was.`);
    return null;
  }
  // "2 naan 160" has a leading quantity and one price. "naan 160" is one naan.
  let quantity = 1;
  if (leading && leading.whole >= 1 && leading.hundredths === 0 && leading.whole <= 99 && price) quantity = leading.whole;
  else if (leading && !price) quantity = leading.whole >= 1 && leading.whole <= 99 ? leading.whole : 1;
  const each = words.some((w) => EACH.has(w));
  let lineTotal = price ? price.paise : 0;
  let confidence: "high" | "low" = "high";
  if (price && each) lineTotal = price.paise * quantity;
  else if (price && quantity > 1 && !words.includes("for") && !words.some((w) => TOTALISH.has(w))) confidence = "low";
  if (!price) confidence = "low";
  const name = titleCase(nameWords);
  const joined = tokens.find((t, i) => t.joined && price && i === price.start);
  if (joined) {
    confidence = "low";
    bill.doubts.push(`${name}: heard "${joined.joined}" as ${joined.w}. Check the price.`);
  }
  return { name, price: lineTotal, quantity, confidence, who: "" };
}

/** "Bill name Ganbei", "restaurant is Ganbei", "we had dinner at Ganbei", "Ganbei restaurant". */
function merchantIn(tokens: Tok[]): string | null {
  const words = tokens.map((t) => t.w);
  const clean = (rest: string[]) => {
    const kept = [...rest];
    while (kept.length > 0 && ["is", "was", "the", "called", "named"].includes(kept[0])) kept.shift();
    return kept.length > 0 ? titleCase(kept) : null;
  };
  const named = words.findIndex((w, i) => (w === "name" || w === "called" || w === "named") && i < words.length - 1);
  if (named >= 0) return clean(words.slice(named + 1));
  if (PLACE_WORDS.has(words[0]) && words.length > 1) return clean(words.slice(1));
  const at = words.findIndex((w) => w === "at" || w === "from");
  if (at >= 0 && at < words.length - 1 && words.slice(0, at).every((w) => MERCHANT_LEAD.has(w))) return clean(words.slice(at + 1));
  if (words.length > 1 && words.length <= 5 && PLACE_WORDS.has(words[words.length - 1]) && words.slice(0, -1).every((w) => !MERCHANT_LEAD.has(w) || w === "the")) {
    return clean(words);
  }
  return null;
}

/**
 * Every amount said out loud, in paise, so anything else (a language model, say) can be held to
 * them. Numbers inside people's names ("Pytester 1") aren't amounts. A value read from two
 * numbers ("2 25" as 225) maps to what was heard, so it can be flagged.
 */
export function spokenAmounts(text: string, memberNames: string[] = []): Map<number, string | null> {
  const amounts = new Map<number, string | null>();
  const words = markPeople(tokenize(text), memberNames);
  for (const n of numbersIn(words)) amounts.set(n.paise, null);
  for (const t of joinSplitPrices(words)) {
    if (!t.joined) continue;
    const value = Number(t.w) * 100;
    if (!amounts.has(value)) amounts.set(value, t.joined);
  }
  return amounts;
}

/** The words of the text, lowercased, without punctuation. */
export function spokenWords(text: string): string[] {
  return tokenize(text).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** Every percentage said ("5 percent", "10%"), in hundredths of a percent. */
export function spokenPercents(text: string): Set<number> {
  const words = tokenize(text).map((w) => ({ w }));
  const found = new Set<number>();
  for (const n of numbersIn(words)) {
    const next = words[n.start + n.length]?.w;
    const after = words[n.start + n.length + 1]?.w;
    if (next === "percent" || next === "pc" || (next === "per" && after === "cent")) found.add(n.whole * 100 + n.hundredths);
  }
  return found;
}

export interface SpokenAssignment {
  itemIndex: number;
  shares: { memberId: number; units: number }[];
}

/**
 * Who had each item, from what was said for it, read the same way as "assign by voice". Adds a
 * note to the bill's doubts for anything that couldn't be filled in. Items whose people
 * included someone not in the group are left alone.
 */
export function billAssignments(bill: SpokenBill, members: SpeechMember[]): SpokenAssignment[] {
  const assignments: SpokenAssignment[] = [];
  bill.items.forEach((item, itemIndex) => {
    if (!item.who || item.whoUnclear) return;
    const result = splitFromSpeech(`zzitem ${item.who}`, [{ index: itemIndex, name: "zzitem", quantity: item.quantity }], members);
    const shares = result.assignments[itemIndex];
    if (shares) assignments.push({ itemIndex, shares: Object.entries(shares).map(([memberId, units]) => ({ memberId: Number(memberId), units })) });
    bill.doubts.push(...result.doubts.map((doubt) => `${item.name}: ${doubt}`));
  });
  return assignments;
}
