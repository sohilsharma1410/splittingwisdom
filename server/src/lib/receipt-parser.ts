import { rupeesToPaise } from "@splittingwisdom/shared";
import { computeTotalsMismatch, type ExtractedItem, type ExtractionResult } from "./receipt-ocr.js";

/**
 * Turns local OCR output (text boxes) into bill data. Pure, so it's easy to test.
 *
 * - All money is integer paise, parsed from the text and never through floats.
 * - An item's `price` is the LINE total, because balances use it as-is and never
 *   multiply by quantity. "Naan 4 55.00 220.00" is price 22000, quantity 4.
 * - Anything unclear stays null or is marked low confidence, for the review screen.
 *   Nothing is guessed: a misread digit is left alone, not corrected.
 */

export interface OcrBox {
  text: string;
  confidence: number;
  /** Corners in the order top-left, top-right, bottom-right, bottom-left. */
  box: number[][];
}

interface Cell {
  text: string;
  confidence: number;
  x: number;
  y: number;
}

interface Token {
  text: string;
  confidence: number;
  cell: number;
}

const LOW_CONFIDENCE = 0.8;
const MAX_RUPEE_DIGITS = 7;
/** Longest plain number accepted as an item's price, so PIN codes and IDs aren't read as money. */
const MAX_PLAIN_DIGITS = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Groups boxes into rows, read left to right, allowing for a tilted photo. */
export function boxesToRows(boxes: OcrBox[]): Cell[][] {
  const usable = boxes.filter((b) => b.box.length === 4 && b.text.trim() !== "");
  if (usable.length === 0) return [];

  const angles: number[] = [];
  const heights: number[] = [];
  for (const { box } of usable) {
    const [[x0, y0], [x1, y1], , [x3, y3]] = box;
    heights.push(Math.hypot(x3 - x0, y3 - y0));
    if (Math.abs(x1 - x0) > Math.abs(y1 - y0)) angles.push(Math.atan2(y1 - y0, x1 - x0));
  }
  const angle = angles.length > 0 ? median(angles) : 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const cells: Cell[] = usable.map(({ text, confidence, box }) => {
    const cx = box.reduce((sum, p) => sum + p[0], 0) / 4;
    const cy = box.reduce((sum, p) => sum + p[1], 0) / 4;
    return { text: text.trim(), confidence, x: cx * cos + cy * sin, y: cy * cos - cx * sin };
  });

  const tolerance = median(heights) * 0.6;
  const rows: Cell[][] = [];
  for (const cell of [...cells].sort((a, b) => a.y - b.y)) {
    const row = rows[rows.length - 1];
    const rowY = row ? row.reduce((sum, c) => sum + c.y, 0) / row.length : 0;
    if (row && Math.abs(cell.y - rowY) <= tolerance) row.push(cell);
    else rows.push([cell]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

/** Parses one amount to paise, or null if it isn't clearly money. Ignores any sign. */
export function parseMoney(raw: string, maxPlainDigits = MAX_PLAIN_DIGITS): number | null {
  const text = raw
    .trim()
    .replace(/^[-(]+|\)+$/g, "")
    .replace(/^(?:₹|rs\.?|inr)\s*/i, "")
    .replace(/\/-$/, "")
    .replace(/\.$/, "");

  let plain: string;
  // A grouped number always ends in three digits, so 640,50 is a decimal comma.
  if (/^\d{1,3}(?:,\d{2,3})*,\d{3}(?:\.\d{1,2})?$/.test(text)) plain = text.replace(/,/g, "");
  else if (/^\d+,\d{2}$/.test(text)) plain = text.replace(",", ".");
  else if (/^\d+(?:\.\d{1,2})?$/.test(text)) plain = text;
  else return null;

  const whole = plain.split(".")[0];
  if (whole.length > MAX_RUPEE_DIGITS) return null;
  const isPlainNumber = plain === text && !plain.includes(".");
  if (isPlainNumber && whole.length > maxPlainDigits) return null;
  return rupeesToPaise(plain);
}

function isNegative(raw: string): boolean {
  return /^\s*[-(]/.test(raw);
}

function isWholeNumber(text: string): boolean {
  return /^\d+$/.test(text.trim());
}

function hasLetters(text: string, count = 2): boolean {
  return (text.match(/\p{L}/gu) ?? []).length >= count;
}

/** Splits cells into tokens, dropping percentages and lone currency marks. */
function tokensOf(row: Cell[]): Token[] {
  const tokens: Token[] = [];
  row.forEach((cell, index) => {
    for (const text of cell.text.replace(/[：]/g, ":").split(/\s+/)) {
      if (text === "" || /^(?:₹|rs\.?|inr|:|-|=)$/i.test(text)) continue;
      if (/^@?\d+(?:\.\d+)?%$/.test(text)) continue;
      tokens.push({ text, confidence: cell.confidence, cell: index });
    }
  });
  return tokens;
}

/** The row's lowercase words, without its amounts. */
function wordsOf(tokens: Token[]): string {
  return tokens
    .filter((token) => parseMoney(token.text) === null)
    .map((token) => token.text.toLowerCase().replace(/[^a-z]/g, ""))
    .filter((word) => word !== "")
    .join(" ");
}

/** Letters only, for phrases that OCR often runs together: "GRANDTOTAL", "Sub Total". */
function labelOf(tokens: Token[]): string {
  return wordsOf(tokens).replace(/ /g, "");
}

type Kind =
  | "ignore"
  | "roundOff"
  | "taxTotal"
  | "tax"
  | "service"
  | "tip"
  | "discount"
  | "subtotal"
  | "total"
  | "grandTotal";

/**
 * Short keywords must match whole words, or they'd swallow dishes: "cash" and Cashew
 * Curry, "card" and Cardamom Tea, "vat" and Vatana Usal. Only long phrases that can't
 * be a dish are matched with the spaces removed.
 */
function classify(words: string): Kind | null {
  const label = words.replace(/ /g, "");
  // "gstin" but not "GST included", which runs together as "gstincluded".
  if (/gstin(?!cl)|gstno|gstnumber|gstreg|fssai|taxinvoice/.test(label)) return "ignore";
  if (/^(?:cash|change|tender|tendered|paid|upi|card|balance|refund|received|payment|saved)\b|^(?:amount paid|you saved)\b/.test(words)) return "ignore";
  if (/^(?:cashpaid|amountpaid|yousaved|totalpaid|totalsaved|totalsavings|totaltendered|totalchange)/.test(label)) return "ignore";
  if (/^(?:noofitems|itemcount)/.test(label)) return "ignore";
  if (/roundoff|rounding|roundedoff/.test(label)) return "roundOff";
  if (/taxable|beforetax|pretax|exclgst/.test(label)) return "subtotal";
  if (/totaltax|totalgst|taxamount|gstamount|taxtotal/.test(label)) return "taxTotal";
  if (/servicetax/.test(label) || /^(?:output )?(?:[csiu]?gst|utgst|vat|cess|tax|kkc|sbc)\b/.test(words)) return "tax";
  if (/^(?:incl|inclusive|includes|including)\b.*\b(?:gst|tax|taxes|vat)\b/.test(words)) return "tax";
  if (/servicecharge|servicefee|packingcharge|deliverycharge|deliveryfee|conveniencefee|covercharge/.test(label) || /^(?:service|svc|srvc|srvchg|sc)$/.test(words)) return "service";
  if (/^(?:tip|tips)\b|gratuity/.test(words)) return "tip";
  if (/discount/.test(label) || /^(?:disc|coupon|less|offer)\b/.test(words)) return "discount";
  if (/subtotal|subtot|itemtotal|foodtotal|grossamount|grosstotal|basicamount/.test(label)) return "subtotal";
  if (/grandtotal|nettotal|netamount|netamt|netpayable|netbill|payable|topay|amountdue|totaldue|finalamount|roundedtotal/.test(label)) return "grandTotal";
  if (/^(?:billamount|billtotal|billamt|invoicetotal|totalamount|totalamt)/.test(label) || /^total\b|\btotal$/.test(words)) return "total";
  return null;
}

/** Labels for details that aren't items. Whole words only, for the same reason as above. */
const METADATA =
  /^(?:bill(?: ?(?:no|num|number))?|billno|billdate|billed|invoice|inv|receipt|date|dt|time|table|tbl|phone|ph|tel|mobile|mob|cashier|waiter|steward|server|captain|kot|order|ord|token|pax|guest|cover|customer|cust|name|address|addr|cin|pan|hsn|sac|shift|terminal|counter)\b|\b(?:thank|thanks|visit|welcome)\b/;

/** A price written with decimals, so "Date Shake 120.00" is an item but "Table 7" isn't. */
function hasDecimalAmount(tokens: Token[]): boolean {
  return tokens.some((token) => /[.,]\d{2}(?:\/-)?\)?$/.test(token.text) && parseMoney(token.text) !== null);
}

function isHeader(label: string): boolean {
  return /item|description|desc|particular|product|menu/.test(label) && /qty|quantity|rate|amount|amt|price|total/.test(label);
}

interface ParsedItem extends ExtractedItem {
  lowConfidence: boolean;
}

/** Reads the numbers at the end of a row as an item. Returns null if there's no price. */
function parseItem(tokens: Token[], rowHasSerial: boolean, pendingName: string | null): ParsedItem | null {
  const cellsWithText = new Set(tokens.filter((t) => parseMoney(t.text) === null && hasLetters(t.text, 1)).map((t) => t.cell));

  const numbers: Token[] = [];
  let end = tokens.length;
  let afterMultiplier = false;
  while (end > 0) {
    const token = tokens[end - 1];
    if (numbers.length > 0 && /^(?:x|×|\*|@)$/i.test(token.text)) {
      afterMultiplier = true;
      end--;
      continue;
    }
    if (parseMoney(token.text) === null) break;
    // A plain number inside a name cell belongs to the name, as in "Pepsi 500 | 2 | 90.00",
    // unless it's clearly a count: "Paneer Tikka 2 x 180.00 360.00".
    if (numbers.length > 0 && cellsWithText.has(token.cell) && isWholeNumber(token.text) && !afterMultiplier) break;
    afterMultiplier = false;
    numbers.unshift(token);
    end--;
  }
  if (numbers.length === 0) return null;

  const amountToken = numbers[numbers.length - 1];
  if (isNegative(amountToken.text)) return null;
  const price = parseMoney(amountToken.text)!;
  if (price === 0) return null;

  const others = numbers.slice(0, -1);
  let quantity = 1;
  let consistent = others.length === 0;

  const asQuantity = (token: Token) => (isWholeNumber(token.text) && Number(token.text) > 0 && Number(token.text) < 1000 ? Number(token.text) : null);

  for (let i = 0; i < others.length && !consistent; i++) {
    const count = asQuantity(others[i]);
    if (count === null) continue;
    for (let j = 0; j < others.length; j++) {
      if (j !== i && parseMoney(others[j].text)! * count === price) {
        quantity = count;
        consistent = true;
        break;
      }
    }
  }
  if (!consistent && others.length === 1) {
    const only = others[0];
    const count = asQuantity(only);
    if (count !== null && !only.text.includes(".")) {
      quantity = count;
      consistent = true;
    } else {
      // "55.00 220.00" is a rate and a line total.
      const rate = parseMoney(only.text)!;
      if (rate > 0 && price % rate === 0) {
        quantity = price / rate;
        consistent = true;
      }
    }
  }
  if (!consistent) {
    const first = others.map(asQuantity).find((count) => count !== null);
    if (first) quantity = first;
  }

  let nameTokens = tokens.slice(0, end);
  if (nameTokens.length > 1 && /^\d{1,3}[.)]?$/.test(nameTokens[0].text)) {
    const lead = Number(nameTokens[0].text.replace(/\D/g, ""));
    // A leading number is a serial number, or the quantity on bills like "2 Tea 80.00".
    if (!rowHasSerial && others.length === 0 && lead > 0 && /^\d+$/.test(nameTokens[0].text)) quantity = lead;
    nameTokens = nameTokens.slice(1);
  }
  const ownName = nameTokens.map((t) => t.text).join(" ").trim();
  const name = hasLetters(ownName) ? ownName : (pendingName ?? "");
  if (!hasLetters(name)) return null;

  const readable = [...nameTokens, ...numbers].every((t) => t.confidence >= LOW_CONFIDENCE);
  const lowConfidence = !consistent || !readable;
  return { name, price, quantity, confidence: lowConfidence ? "low" : "high", lowConfidence };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function toIsoDate(year: number, month: number, day: number): string | null {
  const fullYear = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(fullYear, month - 1, day));
  if (date.getUTCFullYear() !== fullYear || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(fullYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Finds a date, reading numeric dates day first, as Indian bills do. */
export function findDate(text: string): string | null {
  const iso = /(?<!\d)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(text);
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = /(?<!\d)(\d{1,2})[-/. ]?([a-z]{3})[a-z]*[-/., ]{0,2}(\d{4}|\d{2})(?!\d)/i.exec(text);
  const namedMonth = named ? MONTHS.indexOf(named[2].toLowerCase()) : -1;
  if (named && namedMonth >= 0) return toIsoDate(Number(named[3]), namedMonth + 1, Number(named[1]));
  const numeric = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/.exec(text);
  if (numeric) return toIsoDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  return null;
}

interface Amount {
  paise: number;
  negative: boolean;
  confident: boolean;
  whole: boolean;
}

/**
 * The row's rightmost amount. A summary row has a label saying it's money, so it also
 * accepts long plain numbers, which item rows refuse as likely PIN codes or IDs.
 */
function lastAmount(tokens: Token[], maxPlainDigits = MAX_PLAIN_DIGITS): Amount | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const paise = parseMoney(tokens[i].text, maxPlainDigits);
    if (paise !== null) {
      return {
        paise,
        negative: isNegative(tokens[i].text),
        confident: tokens[i].confidence >= LOW_CONFIDENCE,
        whole: isWholeNumber(tokens[i].text),
      };
    }
  }
  return null;
}

/**
 * "Total Qty 5.00" counts things, even when misread as "Total Oty". But "items" can sit
 * in a real total, like "Total (2 items) 1200.00", so that needs a small whole number.
 */
function isCountRow(words: string, amount: Amount): boolean {
  if (/\b(?:qty|oty|quantity|pcs|units?|nos?|count)\b/.test(words)) return true;
  return /\bitems?\b/.test(words) && amount.whole && amount.paise < 100000;
}

/** Returns null when the photo holds no usable bill, so the app falls back to manual entry. */
export function parseReceipt(boxes: OcrBox[]): ExtractionResult | null {
  const rows = boxesToRows(boxes);
  const rowTokens = rows.map(tokensOf);

  let merchant: string | null = null;
  let billDate: string | null = null;
  let inSummary = false;
  let rowHasSerial = false;
  let headerSeen = false;
  let pendingName: string | null = null;
  let doubtfulSummary = false;

  const items: ParsedItem[] = [];
  const taxParts: number[] = [];
  let taxTotal: number | null = null;
  let serviceFee: number | null = null;
  let tip: number | null = null;
  let discount: number | null = null;
  let subtotal: number | null = null;
  let plainTotal: number | null = null;
  let grandTotal: number | null = null;
  let roundOff: { paise: number; negative: boolean } | null = null;

  const add = (current: number | null, paise: number) => (current ?? 0) + paise;

  for (let index = 0; index < rows.length && grandTotal === null; index++) {
    const tokens = rowTokens[index];
    if (tokens.length === 0) continue;
    const rowText = rows[index].map((cell) => cell.text).join(" ");
    billDate ??= findDate(rowText);

    const words = wordsOf(tokens);
    const label = labelOf(tokens);
    if (isHeader(label) && lastAmount(tokens) === null) {
      headerSeen = true;
      rowHasSerial = /^(?:sn|sno|srno|slno|sr|sl)/.test(label);
      pendingName = null;
      continue;
    }

    const kind = classify(words);
    if (kind !== null) {
      if (kind === "ignore") continue;
      let amount = lastAmount(tokens, MAX_RUPEE_DIGITS);
      // Some bills print the amount on the next row, on its own.
      if (amount === null && index + 1 < rows.length && labelOf(rowTokens[index + 1]) === "") {
        amount = lastAmount(rowTokens[index + 1], MAX_RUPEE_DIGITS);
        if (amount !== null) index++;
      }
      if (amount === null || isCountRow(words, amount)) continue;

      inSummary = true;
      if (!amount.confident) doubtfulSummary = true;
      switch (kind) {
        case "roundOff":
          roundOff = amount;
          break;
        case "taxTotal":
          taxTotal = amount.paise;
          break;
        case "tax":
          taxParts.push(amount.paise);
          break;
        case "service":
          serviceFee = add(serviceFee, amount.paise);
          break;
        case "tip":
          tip = add(tip, amount.paise);
          break;
        case "discount":
          discount = add(discount, amount.paise);
          break;
        case "subtotal":
          subtotal ??= amount.paise;
          break;
        case "total":
          // A later row wins: "Total" is often the pre-tax figure.
          if (plainTotal !== null) subtotal ??= plainTotal;
          plainTotal = amount.paise;
          break;
        case "grandTotal":
          grandTotal = amount.paise;
          break;
      }
      continue;
    }

    if (inSummary) continue;
    if (METADATA.test(words) && !hasDecimalAmount(tokens)) continue;

    const hasAmount = lastAmount(tokens) !== null;
    if (merchant === null && items.length === 0 && !headerSeen && hasLetters(label, 3) && !hasAmount) {
      merchant = rows[index].map((cell) => cell.text).join(" ");
      continue;
    }

    const item = parseItem(tokens, rowHasSerial, pendingName);
    if (item) {
      items.push(item);
      pendingName = null;
    } else if (hasLetters(label, 3) && !hasAmount) {
      // A name printed above its numbers.
      pendingName = rows[index].map((cell) => cell.text).join(" ");
    }
  }

  if (billDate === null) {
    for (const row of rows) {
      billDate = findDate(row.map((cell) => cell.text).join(" "));
      if (billDate) break;
    }
  }

  const total = grandTotal ?? plainTotal;
  if (grandTotal !== null && plainTotal !== null && plainTotal !== grandTotal) subtotal ??= plainTotal;
  if (items.length === 0 && total === null) return null;

  const itemsSum = items.reduce((sum, item) => sum + item.price, 0);
  let tax: number | null = taxTotal ?? (taxParts.length > 0 ? taxParts.reduce((sum, part) => sum + part, 0) : null);
  const withoutRound = (includeTax: boolean) =>
    itemsSum + (includeTax ? (tax ?? 0) : 0) + (serviceFee ?? 0) + (tip ?? 0) - (discount ?? 0);

  // Prices that already include GST: the bill lists the tax for information only, and adding
  // it again would charge everyone twice. Under 50 paise is rounding, as in the shared totals check.
  let taxIncluded: number | null = null;
  if (total !== null && tax !== null && roundOff === null && withoutRound(true) !== total && Math.abs(withoutRound(false) - total) < 50) {
    taxIncluded = tax;
    tax = null;
  }

  // Round-off is often printed without its sign, so the total decides when it can.
  let roundOffAmount: number | null = null;
  if (roundOff !== null && roundOff.paise !== 0) {
    const gap = total === null ? null : total - withoutRound(true);
    roundOffAmount = gap !== null && Math.abs(gap) === roundOff.paise ? gap : roundOff.negative ? -roundOff.paise : roundOff.paise;
  }

  // The same totals rule as every other reader, so the review screen behaves the same.
  const totalsMismatch = computeTotalsMismatch(
    items,
    { tax, tip, serviceFee, discount, roundOff: roundOffAmount },
    total,
  );
  const lowItems = items.filter((item) => item.lowConfidence).length;
  const overallConfidence =
    total === null || items.length === 0 || totalsMismatch !== null || doubtfulSummary || lowItems * 3 >= items.length ? "low" : "high";

  return {
    merchant,
    billDate,
    items: items.map(({ name, price, quantity, confidence }) => ({ name, price, quantity, confidence })),
    subtotalAmount: subtotal,
    taxAmount: tax,
    taxIncludedAmount: taxIncluded,
    tipAmount: tip,
    serviceFeeAmount: serviceFee,
    discountAmount: discount,
    roundOffAmount,
    totalAmount: total,
    overallConfidence,
    totalsMismatch,
  };
}
