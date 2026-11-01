/**
 * Reads numbers out of speech-recognition text: digits ("250", "1,250", "10.5") and English
 * number words ("two hundred and fifty", "one thousand two hundred", "two lakh"). Everything is
 * whole numbers and whole paise: no floating point, so a spoken price can't drift.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000 };

/** The most a spoken amount can be. Far above any bill; stops a mis-heard digit string from becoming a huge price. */
const MAX_RUPEES = 1_000_000;

export interface SpokenNumber {
  /** Whole number part. */
  whole: number;
  /** Hundredths, 0-99, when a decimal was said ("ten point five" is 50). */
  hundredths: number;
  /** How many tokens it used. */
  length: number;
}

const DIGITS = /^\d+(?:,\d{3})*(?:\.\d{1,2})?$/;

/** Reads a number starting at tokens[start], or null if there isn't one. */
export function readNumber(tokens: string[], start: number): SpokenNumber | null {
  const first = tokens[start];
  if (first === undefined) return null;

  if (DIGITS.test(first)) {
    const [whole, fraction = ""] = first.replace(/,/g, "").split(".");
    if (whole.length > 9) return null;
    return { whole: Number(whole), hundredths: Number((fraction + "00").slice(0, 2)), length: 1 };
  }

  // Number words. A running total of the small part, and a total of the completed big parts.
  let total = 0;
  let current = 0;
  let used = 0;
  let sawWord = false;
  let i = start;
  for (; i < tokens.length; i++) {
    const word = tokens[i];
    if (UNITS[word] !== undefined) {
      current += UNITS[word];
    } else if (TENS[word] !== undefined) {
      current += TENS[word];
    } else if (word === "hundred") {
      current = (current === 0 ? 1 : current) * 100;
    } else if (SCALES[word] !== undefined) {
      total += (current === 0 ? 1 : current) * SCALES[word];
      current = 0;
    } else if (word === "and" && sawWord && SCALES[tokens[i + 1]] === undefined && (UNITS[tokens[i + 1]] !== undefined || TENS[tokens[i + 1]] !== undefined) && /hundred|thousand|lakh|lac/.test(tokens[i - 1] ?? "")) {
      // "two hundred and fifty": the "and" belongs to the number.
    } else {
      break;
    }
    sawWord = true;
    used = i - start + 1;
  }
  if (!sawWord) return null;
  let whole = total + current;
  let length = used;

  // "ten point five" / "ten point five zero"
  if (tokens[start + length] === "point") {
    const digits: number[] = [];
    let j = start + length + 1;
    while (digits.length < 2 && UNITS[tokens[j]] !== undefined && UNITS[tokens[j]] < 10) digits.push(UNITS[tokens[j++]]);
    if (digits.length > 0) {
      return { whole, hundredths: Number((digits.join("") + "00").slice(0, 2)), length: j - start };
    }
  }
  // "a hundred" handled by the caller; here "hundred" alone reads as 100 above.
  if (whole > MAX_RUPEES) whole = MAX_RUPEES;
  return { whole, hundredths: 0, length };
}

/** A spoken amount in whole paise, or null if it's out of range. */
export function toPaise(n: SpokenNumber): number | null {
  if (n.whole > MAX_RUPEES) return null;
  return n.whole * 100 + n.hundredths;
}

/** True when a word is only a number or part of one, so it can't be an item name. */
export function isNumberWord(word: string): boolean {
  return UNITS[word] !== undefined || TENS[word] !== undefined || SCALES[word] !== undefined || DIGITS.test(word);
}
