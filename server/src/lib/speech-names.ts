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
