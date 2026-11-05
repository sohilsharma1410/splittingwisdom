/**
 * Matches a word from speech recognition to a name the app already knows (a group member).
 * The vocabulary is small and closed, so the question is "which of these people sounds like
 * this word?", not "what word is this?". Speech recognition spells names by ear ("Karen" for
 * Karan, "Pria" for Priya), so this compares how names sound with a rough consonant skeleton
 * plus a check on the spelling, and stays quiet when two people sound alike.
 *
 * A name that two members could both be ("Kiran" and "Karan" are both K-R-N) comes back as
 * ambiguous, and the caller leaves it unassigned. A blank is safe and a wrong guess isn't.
 */

/** Consonants that Indian-English speech and spelling swap freely, folded to one letter. */
function skeleton(name: string): string {
  const folded = name
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/(?:th|dh|kh|gh|bh|jh|ch)(?=[aeiouy])/g, (m) => (m === "ch" ? "c" : m[0])) // Rohit/Rohith, Sidharth/Siddharth
    .replace(/sh/g, "s")
    .replace(/w/g, "v")
    .replace(/q/g, "k")
    .replace(/c/g, "k")
    .replace(/z/g, "j")
    .replace(/x/g, "ks")
    .replace(/(.)\1+/g, "$1")
    .replace(/h/g, "");
  const first = /^[aeiou]/.test(folded) ? "a" : "";
  return first + folded.replace(/[aeiouy]/g, "");
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const held = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = held;
    }
  }
  return row[b.length];
}

/** True when `said` is plausibly `known` heard by a recogniser. Both are single words. */
export function soundsLike(said: string, known: string): boolean {
  const a = said.toLowerCase();
  const b = known.toLowerCase();
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false; // too short to tell apart from everyday words ("ash")
  const sa = skeleton(a);
  const sb = skeleton(b);
  if (sa.length < 2 || sb.length < 2) return false;
  if (sa[0] !== sb[0]) return false; // first sound is rarely misheard, and it stops a lot of nonsense
  // The skeleton may differ by one slip, but only in a longer name.
  const skeletonClose = sa === sb || (Math.min(sa.length, sb.length) >= 4 && distance(sa, sb) <= 1);
  if (!skeletonClose) return false;
  return distance(a, b) <= Math.max(2, Math.floor(Math.max(a.length, b.length) / 2));
}

const NUMBER_WORDS: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };

function nameParts(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((part) => NUMBER_WORDS[part] ?? part);
}

/** Letters and digits of some name parts, kept apart: "Pytester 1" is "pytester" and "1". */
function letterAndDigits(parts: string[]): { letters: string; digits: string } {
  return {
    letters: parts.filter((p) => !/^\d+$/.test(p)).join(""),
    digits: parts.filter((p) => /^\d+$/.test(p)).join(" "),
  };
}

function lettersClose(said: string, known: string): boolean {
  if (said === known) return true;
  if (said.length < 4 || known.length < 4) return false;
  return soundsLike(said, known) || distance(said, known) <= 1;
}

export interface PersonSpan {
  /** How many words the name used. */
  length: number;
  /** Which of the given names it could be. More than one means it's ambiguous. */
  indexes: number[];
}

/**
 * A name of more than one word ("Pytester 1", "Sohil Sharma"), or a whole one-word name said
 * exactly, starting at tokens[start]. Recognisers split and respell names ("pi tester one"), so
 * the words are compared run together, by sound. Digits must match exactly, because "Pytester 1"
 * and "Pytester 2" are different people. One mis-heard word on its own is left to the caller,
 * which knows when a word is a dish or a keyword.
 */
export function matchPersonSpan(tokens: string[], start: number, names: string[], maxLength = 4): PersonSpan | null {
  const known = names.map(nameParts);
  for (let length = Math.min(maxLength, tokens.length - start); length >= 1; length--) {
    const raw = tokens.slice(start, start + length);
    if (raw.some((t) => !/^[\p{L}\p{N}]+$/u.test(t))) continue;
    const said = raw.map((t) => NUMBER_WORDS[t] ?? t);
    if (/^\d+$/.test(said[0])) continue; // a name never starts with a number
    const s = letterAndDigits(said);
    if (!s.letters) continue;
    const exact: number[] = [];
    const close: number[] = [];
    known.forEach((parts, index) => {
      if (length === 1) {
        // Only when someone is called exactly this; "Ravi" also fits "Ravi Kumar", which keeps it ambiguous.
        if (parts.includes(said[0]) && known.some((other) => other.length === 1 && other[0] === said[0])) exact.push(index);
        return;
      }
      // Any run of the name's parts that has letters: "sohil sharma", or "pytester 1".
      for (let from = 0; from < parts.length; from++) {
        for (let to = from + 1; to <= parts.length; to++) {
          const k = letterAndDigits(parts.slice(from, to));
          if (!k.letters || k.digits !== s.digits) continue;
          // A run of two or more of the name's own words, or one word plus its digits.
          if (to - from < 2 && !k.digits) continue;
          if (k.letters === s.letters) exact.push(index);
          else if (lettersClose(s.letters, k.letters)) close.push(index);
        }
      }
    });
    const found = [...new Set(exact.length > 0 ? exact : close)];
    if (found.length > 0) return { length, indexes: found };
  }
  return null;
}
