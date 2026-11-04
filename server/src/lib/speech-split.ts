/**
 * Works out who had what from a spoken sentence, using plain rules and no language model
 * (plan D4). Not connected to the app: this exists to measure how far rules get.
 *
 * It only links item numbers to member ids and share counts. It never sees or produces an
 * amount, so it can't get money wrong: shared/lib does all the arithmetic. Anything unclear
 * stays unassigned, because a blank is safe and a wrong guess isn't.
 */

import { soundsLike } from "./speech-names.js";

export interface SpeechItem {
  index: number;
  name: string;
  quantity: number;
}

export interface SpeechMember {
  id: number;
  name: string;
  isSpeaker?: boolean;
}

export interface SpeechSplit {
  /** Item number -> member id -> units. Equal shares are 1 each. */
  assignments: Record<number, Record<number, number>>;
  /** Plain reasons for anything left unassigned, to show on the review screen. */
  doubts: string[];
}

type Tag =
  | { kind: "person"; ids: number[]; word: string }
  | { kind: "item"; indexes: number[]; word: string; count?: number }
  | { kind: "number"; value: number }
  | { kind: "everyone" | "except" | "excludeBefore" | "rest" | "verb" | "shared" | "each" | "and" }
  | { kind: "stop"; reason: string };

const SPEAKER = new Set(["i", "me", "my", "mine", "myself", "main", "mai", "mera", "meri", "mere", "maine", "mujhe"]);
const EVERYONE = new Set(["everyone", "everybody", "all", "sab", "sabne", "sabhi", "sabke", "sabko"]);
const EXCEPT = new Set(["except", "excluding", "without", "minus", "but"]);
const EXCLUDE_BEFORE = new Set(["chhod", "chod", "chhodke", "alawa", "alaawa", "siwa"]);
const REST = new Set(["rest", "remaining", "baaki", "baki", "everything", "others"]);
const VERBS = new Set(["had", "have", "took", "take", "got", "ate", "eat", "drank", "ordered", "liya", "li", "khaya", "khayi", "pi", "piya"]);
const SHARED = new Set(["shared", "shares", "share", "split"]);
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ek: 1, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5 };
const NEGATIONS = new Set(["not", "didn't", "didnt", "don't", "dont", "doesn't", "doesnt", "never", "nahi", "nahin", "na"]);
const UNSURE = new Set(["maybe", "might", "probably", "perhaps", "shayad", "unsure", "sure", "think", "guess", "actually", "wait", "sorry", "correction", "wanted"]);
const PAYING = new Set(["paid", "pay", "pays", "paying", "treated", "treat", "bought"]);
const UNKNOWN_GROUP = new Set(["we", "us", "both", "dono", "hum", "humne", "they", "them"]);
/** Common words that must never be fuzzy-matched to a name or a dish. */
const NOT_NAMES = new Set(["the", "and", "for", "had", "was", "were", "with", "that", "this", "have", "are", "aur", "ko", "ne", "ka", "ke", "ki", "liye", "mein", "one", "do", "is", "to", "of", "a", "an", "between", "else", "give", "there", "their", "then", "item", "dish", "sweet", "only", "by", "just", "also", "too"]);

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else {
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else {
        i++;
        j++;
      }
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Speech recognition often misspells names and dishes, so allow one small slip in longer words. */
function sameWord(said: string, known: string): boolean {
  if (said === known) return true;
  if (said.length < 4 || known.length < 4 || NOT_NAMES.has(said)) return false;
  return editDistanceAtMostOne(said, known);
}

/** Whether a spoken word is about people ("me", "everyone", a member's name, heard badly) rather than a dish. */
export function isPersonWord(token: string, memberNames: string[]): boolean {
  if (SPEAKER.has(token) || EVERYONE.has(token)) return true;
  if (NOT_NAMES.has(token)) return false;
  return memberNames.some((name) => words(name).some((part) => part === token || sameWord(token, part) || soundsLike(token, part)));
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\bi'(?:ll|ve|d|m)\b/g, "i")
    .replace(/'s\b/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/** The longest run of words at `start` that fits one or more items. */
function matchItems(tokens: string[], start: number, items: SpeechItem[]): { indexes: number[]; length: number } | null {
  let best: { indexes: number[]; length: number } | null = null;
  for (let length = 1; start + length <= tokens.length && length <= 4; length++) {
    const raw = tokens.slice(start, start + length);
    const said = raw.map(singular);
    if (said.some((word) => NOT_NAMES.has(word) && word.length < 4)) break;
    const indexes = items
      .filter((item) => {
        const rawName = words(item.name);
        const name = rawName.map(singular);
        // Compare as spoken and with plurals trimmed: trimming "chaas" and "chas" to "cha" and "chaa" would hide a match.
        const same = (offset: number, from: number) =>
          name[from + offset] !== undefined &&
          (sameWord(said[offset], name[from + offset]) || sameWord(raw[offset], rawName[from + offset]) || sameWord(raw[offset], name[from + offset]) || sameWord(said[offset], rawName[from + offset]));
        return name.some((_, from) => said.every((_w, offset) => same(offset, from)));
      })
      .map((item) => item.index);
    if (indexes.length === 0) break;
    best = { indexes, length };
  }
  return best;
}

function tagWords(text: string, items: SpeechItem[], members: SpeechMember[]): Tag[] {
  const tokens = words(text);
  const tags: Tag[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if (UNSURE.has(token)) tags.push({ kind: "stop", reason: "It sounded unsure, so nothing was filled in from that." });
    else if (NEGATIONS.has(token)) tags.push({ kind: "stop", reason: "Someone not having something can't be filled in automatically." });
    else if (PAYING.has(token)) tags.push({ kind: "stop", reason: "Who paid is set separately from who had what." });
    else if (UNKNOWN_GROUP.has(token)) {
      if (next === "all" || (token === "us" && tokens[i - 1] === "of")) continue;
      tags.push({ kind: "stop", reason: `"${token}" could mean several people, so please choose them.` });
    } else if (EVERYONE.has(token)) tags.push({ kind: "everyone" });
    else if (token === "each") tags.push({ kind: "each" });
    else if (EXCLUDE_BEFORE.has(token)) tags.push({ kind: "excludeBefore" });
    else if (EXCEPT.has(token)) tags.push({ kind: "except" });
    else if (REST.has(token)) tags.push({ kind: "rest" });
    else if (SHARED.has(token)) tags.push({ kind: "shared" });
    else if (VERBS.has(token)) tags.push({ kind: "verb" });
    else if (token === "and" || token === "aur") tags.push({ kind: "and" });
    else if (/^\d+$/.test(token) && Number(token) < 100) tags.push({ kind: "number", value: Number(token) });
    else if (NUMBERS[token] !== undefined) tags.push({ kind: "number", value: NUMBERS[token] });
    else if (token === "do" && next !== undefined && matchItems(tokens, i + 1, items)) tags.push({ kind: "number", value: 2 });
    else if (SPEAKER.has(token) && !(token === "main" && next === "course")) {
      const speaker = members.find((member) => member.isSpeaker);
      if (speaker) tags.push({ kind: "person", ids: [speaker.id], word: token });
    } else {
      const byName = (match: (part: string) => boolean) => members.filter((member) => words(member.name).some(match));
      // Someone saying a name exactly is believed over a similar-sounding name ("Kiran" when "Karan" is also in the group).
      const exact = byName((part) => part === token);
      const people = exact.length > 0 ? exact : byName((part) => sameWord(token, part) || soundsLike(token, part));
      if (people.length > 0 && !NOT_NAMES.has(token)) {
        tags.push({ kind: "person", ids: people.map((member) => member.id), word: token });
        continue;
      }
      const match = NOT_NAMES.has(token) ? null : matchItems(tokens, i, items);
      // A word right before "had/took/ate" that we don't know is probably somebody's name, heard badly.
      // Skipping it would hand their items to whoever is named next, so hold the sentence back instead.
      if (!match && !NOT_NAMES.has(token) && next !== undefined && VERBS.has(next) && token.length >= 3 && !/^\d+$/.test(token) && NUMBERS[token] === undefined) {
        tags.push({ kind: "stop", reason: `Couldn't tell who "${token}" is, so that part wasn't filled in.` });
        continue;
      }
      if (match) {
        const previous = tags[tags.length - 1];
        const count = previous?.kind === "number" ? previous.value : undefined;
        if (count !== undefined) tags.pop();
        tags.push({ kind: "item", indexes: match.indexes, word: tokens.slice(i, i + match.length).join(" "), count });
        i += match.length - 1;
      }
    }
  }
  return tags;
}

interface Clause {
  people: { ids: number[]; word: string }[];
  excluded: number[];
  items: { indexes: number[]; word: string; count?: number }[];
  everyone: boolean;
  rest: boolean;
  shared: boolean;
  each: boolean;
  exceptMode: boolean;
  /** "person" for "Ravi had the naan", "item" for "the naan is for Ravi". */
  startsWith: "person" | "item" | null;
  /** A number waiting for its person: the second "two" in "two for me, two for Priya". */
  pendingCount?: number;
  stops: string[];
}

const newClause = (): Clause => ({
  people: [],
  excluded: [],
  items: [],
  everyone: false,
  rest: false,
  shared: false,
  each: false,
  exceptMode: false,
  startsWith: null,
  stops: [],
});

function toClauses(tags: Tag[]): Clause[] {
  const clauses: Clause[] = [];
  let clause = newClause();
  const begin = () => {
    clauses.push(clause);
    clause = newClause();
  };

  tags.forEach((tag, position) => {
    const next = tags[position + 1];
    switch (tag.kind) {
      case "person": {
        if (clause.exceptMode) {
          clause.excluded.push(...tag.ids);
          break;
        }
        const hasPair = clause.items.length > 0 || clause.rest;
        const startsNewSentence = hasPair && (clause.people.length > 0 || clause.everyone) && next?.kind === "verb";
        if (hasPair && clause.startsWith === "person") begin();
        else if (startsNewSentence) begin();
        clause.startsWith ??= "person";
        clause.people.push({ ids: tag.ids, word: tag.word });
        break;
      }
      case "item": {
        const hasPeople = clause.people.length > 0 || clause.everyone;
        if (hasPeople && clause.startsWith === "item") begin();
        clause.startsWith ??= "item";
        clause.items.push({ indexes: tag.indexes, word: tag.word, count: tag.count });
        break;
      }
      case "number": {
        // "two for Priya" after "two naans for me": the same item, for the next person.
        const last = clause.items[clause.items.length - 1];
        const isAnotherShare = last !== undefined && last.count !== undefined && clause.people.length > 0;
        if (isAnotherShare && !clause.each) {
          begin();
          clause.items.push({ indexes: last.indexes, word: last.word, count: tag.value });
          clause.startsWith = "item";
        }
        break;
      }
      case "everyone":
        if (clause.rest && clause.people.length > 0) begin();
        clause.everyone = true;
        clause.startsWith ??= "person";
        break;
      case "except":
        // "but" only excludes straight after "everyone".
        if (clause.everyone) clause.exceptMode = true;
        else if (clause.rest) clause.stops.push("An exception to everything can't be filled in automatically.");
        break;
      case "excludeBefore": {
        const person = clause.people.pop();
        if (person) clause.excluded.push(...person.ids);
        break;
      }
      case "rest": {
        const hasPair = (clause.people.length > 0 || clause.everyone) && clause.items.length > 0;
        if (hasPair) begin();
        clause.rest = true;
        break;
      }
      case "shared":
        clause.shared = true;
        break;
      case "each":
        clause.each = true;
        break;
      case "stop":
        clause.stops.push(tag.reason);
        break;
      case "and":
      case "verb":
        break;
    }
  });
  clauses.push(clause);
  return clauses;
}

/** Works out a split. Anything that isn't clear is left out and explained in `doubts`. */
export function splitFromSpeech(text: string, items: SpeechItem[], members: SpeechMember[]): SpeechSplit {
  const allIds = members.map((member) => member.id);
  const clauses = toClauses(tagWords(text, items, members));
  const doubts: string[] = [];
  const shares = new Map<number, Map<number, { units: number; counted: boolean }>>();

  // Being unsure about one thing puts the whole sentence in doubt.
  const unsure = clauses.find((clause) => clause.stops.some((reason) => reason.startsWith("It sounded unsure")));
  if (unsure) return { assignments: {}, doubts: [unsure.stops.find((reason) => reason.startsWith("It sounded unsure"))!] };

  // Someone named with no item usually changes the sentence around them: "so did Ravi", "Ravi
  // too", "Karan the other half". Filling in the rest would be a wrong guess, so leave it all.
  const leftOver = clauses.find(
    (clause) => clause.stops.length === 0 && clause.people.length > 0 && clause.items.length === 0 && !clause.rest,
  );
  if (leftOver) {
    return { assignments: {}, doubts: [`Couldn't tell what "${leftOver.people[0].word}" had, so nothing was filled in.`] };
  }

  const named = new Set<number>();
  const pending: { clause: Clause; people: number[] }[] = [];

  for (const clause of clauses) {
    if (clause.stops.length > 0) {
      doubts.push(...clause.stops);
      continue;
    }
    const ambiguous = clause.people.find((person) => person.ids.length > 1);
    if (ambiguous) {
      doubts.push(`More than one person could be "${ambiguous.word}", so please choose.`);
      continue;
    }
    // "All the naan went to Karan" names everyone and someone, which can't both be meant.
    if (clause.everyone && clause.people.length > 0) {
      doubts.push(`Couldn't tell if "${clause.people[0].word}" or everyone had this, so please choose.`);
      continue;
    }
    let people = clause.everyone ? [...allIds] : clause.people.flatMap((person) => person.ids);
    if (people.length === 0 && clause.shared && clause.rest) people = [...allIds];
    people = [...new Set(people)].filter((id) => !clause.excluded.includes(id));
    if (people.length === 0) continue;

    if (clause.rest) {
      pending.push({ clause, people });
      continue;
    }
    for (const item of clause.items) {
      if (item.indexes.length > 1) {
        doubts.push(`"${item.word}" could be more than one item, so please choose.`);
        continue;
      }
      const index = item.indexes[0];
      named.add(index);
      const entry = shares.get(index) ?? new Map<number, { units: number; counted: boolean }>();
      const counted = item.count !== undefined && !clause.each && people.length === 1;
      for (const id of people) {
        const previous = entry.get(id);
        entry.set(id, { units: (previous?.units ?? 0) + (counted ? item.count! : previous ? 0 : 1), counted });
      }
      shares.set(index, entry);
    }
  }

  // "Everything else" means items nobody was named for, once all the sentences are read.
  for (const { people } of pending) {
    for (const item of items) {
      if (named.has(item.index)) continue;
      named.add(item.index);
      shares.set(item.index, new Map(people.map((id) => [id, { units: 1, counted: false }])));
    }
  }

  const assignments: SpeechSplit["assignments"] = {};
  for (const [index, entry] of shares) {
    const item = items.find((candidate) => candidate.index === index)!;
    const values = [...entry.values()];
    if (values.some((share) => share.counted)) {
      // Counts must cover the whole line. If they don't, whoever is named would pay for
      // units nobody claimed, because shares split the line's full price.
      const sum = values.reduce((total, share) => total + share.units, 0);
      if (sum !== item.quantity) {
        doubts.push(`The amounts said for ${item.name} don't add up to ${item.quantity}, so please check.`);
        continue;
      }
    }
    assignments[index] = Object.fromEntries([...entry].map(([id, share]) => [id, share.units]));
  }
  return { assignments, doubts };
}
