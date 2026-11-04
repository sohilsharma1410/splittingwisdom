import { describe, expect, it } from "vitest";
import { splitFromSpeech, type SpeechSplit } from "./speech-split.js";
import { DEV_CASES, EVAL_ITEMS, EVAL_MEMBERS, HELD_OUT_CASES, STRESS_CASES, type EvalCase } from "./speech-split.eval-data.js";

/** Raise only for real improvements. The first run, before tuning on these, was 16/30 exact and 9 wrong. */
const STRESS_EXACT = 19;

const split = (text: string, members = EVAL_MEMBERS) => splitFromSpeech(text, EVAL_ITEMS, members);

/** "exact" got it all. "blank" left things out but assigned nothing wrong. "wrong" made a bad guess. */
function grade(result: SpeechSplit, expected: EvalCase["expected"]): "exact" | "blank" | "wrong" {
  const got = Object.entries(result.assignments);
  const wrong = got.some(([item, shares]) => JSON.stringify(sorted(shares)) !== JSON.stringify(sorted(expected[Number(item)] ?? {})));
  if (wrong) return "wrong";
  return got.length === Object.keys(expected).length ? "exact" : "blank";
}
const sorted = (shares: Record<number, number>) => Object.entries(shares).sort();

function score(cases: EvalCase[]) {
  const results = cases.map((c) => ({ text: c.text, grade: grade(split(c.text), c.expected) }));
  return {
    exact: results.filter((r) => r.grade === "exact").length,
    blank: results.filter((r) => r.grade === "blank").map((r) => r.text),
    wrong: results.filter((r) => r.grade === "wrong").map((r) => r.text),
  };
}

describe("the test sentences (plan D4.7)", () => {
  it("gets the tuning sentences right", () => {
    expect(score(DEV_CASES)).toEqual({ exact: 20, blank: [], wrong: [] });
  });

  it("gets the separate sentences right, though these aren't independent of the rules", () => {
    expect(score(HELD_OUT_CASES)).toEqual({ exact: 20, blank: [], wrong: [] });
  });

  it("makes no wrong guesses on casual phrasing, and leaves what it can't read blank", () => {
    const result = score(STRESS_CASES);
    expect(result.wrong).toEqual([]);
    expect(result.exact).toBeGreaterThanOrEqual(STRESS_EXACT);
  });
});

describe("splitFromSpeech", () => {
  it("only ever returns item numbers, member ids and whole share counts", () => {
    for (const c of [...DEV_CASES, ...HELD_OUT_CASES, ...STRESS_CASES]) {
      const { assignments } = split(c.text);
      for (const [item, shares] of Object.entries(assignments)) {
        expect(EVAL_ITEMS.some((i) => i.index === Number(item))).toBe(true);
        for (const [member, units] of Object.entries(shares)) {
          expect(EVAL_MEMBERS.some((m) => m.id === Number(member))).toBe(true);
          expect(Number.isInteger(units) && units > 0).toBe(true);
        }
      }
    }
  });

  it("asks when two people share a name", () => {
    const members = [...EVAL_MEMBERS, { id: 5, name: "Ravi Kumar" }];
    const result = split("ravi had the naan", members);
    expect(result.assignments).toEqual({});
    expect(result.doubts[0]).toContain("ravi");
  });

  it("asks when a word fits two items", () => {
    const result = split("karan had the masala");
    expect(result.assignments).toEqual({});
    expect(result.doubts[0]).toContain("masala");
  });

  it("refuses counts that don't cover the line, because the named person would pay for all of it", () => {
    const result = split("karan had one naan");
    expect(result.assignments).toEqual({});
    expect(result.doubts[0]).toContain("Butter Naan");
  });

  it("treats a correction as doubt about the whole sentence", () => {
    expect(split("karan had the soda actually no ravi had it").assignments).toEqual({});
  });

  it("leaves everything blank for empty speech", () => {
    expect(split("")).toEqual({ assignments: {}, doubts: [] });
  });

  it("is not thrown by 'only' and 'by', even when an item's name has them", () => {
    const items = [
      { index: 0, name: "Chicken Tikka", quantity: 1 },
      { index: 1, name: "Curd Shared By Me", quantity: 1 },
      { index: 2, name: "Thali Non-Veg By Only Me", quantity: 1 },
      { index: 3, name: "Chicken Lollipop", quantity: 5 },
    ];
    const members = [{ id: 1, name: "Ann", isSpeaker: true }, { id: 2, name: "Bob" }, { id: 3, name: "Cat" }];
    const result = splitFromSpeech("Chicken Tikka, only Bob. Curd only me, Thali Bob, Cat. Chicken Lollipop shared by everyone.", items, members);
    expect(result.assignments).toEqual({ 0: { 2: 1 }, 1: { 1: 1 }, 2: { 2: 1, 3: 1 }, 3: { 1: 1, 2: 1, 3: 1 } });
    expect(result.doubts).toEqual([]);
  });
});
