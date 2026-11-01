import { describe, expect, it } from "vitest";
import { soundsLike } from "./speech-names.js";
import { splitFromSpeech } from "./speech-split.js";

// How a recogniser tends to spell these names by ear. Written by hand, not from real recordings.
const HEARD: Record<string, string[]> = {
  Ravi: ["ravi", "rawi", "ravee", "ravy"],
  Asha: ["asha", "aasha", "ashah", "asha"],
  Karan: ["karan", "karen", "kiran", "karran", "caran"],
  Priya: ["priya", "pria", "preya", "priyah", "prea"],
  Siddharth: ["siddharth", "sidharth", "siddhart", "sidarth", "siddarth"],
  Meera: ["meera", "mira", "meira", "miera"],
  Rohan: ["rohan", "rohaan", "rohun"],
  Ananya: ["ananya", "ananaya", "annanya", "ananiya"],
};
// "pray", "rave" and "kern" do sound like Priya, Ravi and Karan and are accepted: they are rare on a bill, and Confirm catches them.
const NEVER_NAMES = ["ash", "ask", "robe", "rain", "road", "price", "care", "carry", "mirror", "near", "rose", "sit", "side", "any", "analyse", "crane", "apple", "naan"];

describe("matching heard names to the people in the group", () => {
  it("accepts the usual ways each name is misheard", () => {
    for (const [name, spellings] of Object.entries(HEARD)) {
      for (const said of spellings) {
        // Karan and Kiran are the same sound: with both in a group that's ambiguous (tested below), so skip here.
        if (name === "Karan" && said === "kiran") continue;
        expect(soundsLike(said, name), `${said} -> ${name}`).toBe(true);
      }
    }
  });

  it("does not turn everyday words or dishes into a name", () => {
    for (const word of NEVER_NAMES) {
      for (const name of Object.keys(HEARD)) expect(soundsLike(word, name), `${word} -> ${name}`).toBe(false);
    }
  });

  it("does not match different names to each other", () => {
    const names = Object.keys(HEARD);
    for (const a of names) for (const b of names) if (a !== b) expect(soundsLike(a, b), `${a} ~ ${b}`).toBe(false);
  });
});

describe("in a sentence", () => {
  const items = [
    { index: 0, name: "Paneer Butter Masala", quantity: 1 },
    { index: 1, name: "Butter Naan", quantity: 4 },
    { index: 2, name: "Veg Biryani", quantity: 1 },
  ];
  const group = [
    { id: 1, name: "Asha", isSpeaker: true },
    { id: 2, name: "Ravi" },
    { id: 3, name: "Karan" },
    { id: 4, name: "Priya" },
  ];

  it("assigns when the name was misspelled but only one person sounds like it", () => {
    expect(splitFromSpeech("karen had the biryani", items, group).assignments).toEqual({ 2: { 3: 1 } });
    expect(splitFromSpeech("pria and i shared the naan", items, group).assignments).toEqual({ 1: { 1: 1, 4: 1 } });
    expect(splitFromSpeech("rawi had the paneer butter masala", items, group).assignments).toEqual({ 0: { 2: 1 } });
  });

  it("finds a dish even when a plural 's' was misheard or dropped ('chas' for 'chaas')", () => {
    const dishes = [{ index: 0, name: "Veg Biryani", quantity: 1 }, { index: 1, name: "Masala Chaas", quantity: 1 }];
    const result = splitFromSpeech("give the biryani to ravi and split the chas between me and priya", dishes, group);
    expect(result.assignments).toEqual({ 0: { 2: 1 }, 1: { 1: 1, 4: 1 } });
  });

  it("holds a sentence back when a name before 'had' isn't anyone it knows, instead of giving their items to someone else", () => {
    const result = splitFromSpeech("zoltan had the biryani and i had the naan", items, group);
    expect(result.assignments).not.toHaveProperty("2");
    expect(result.doubts.join(" ")).toContain("zoltan");
  });

  it("leaves it blank when two people sound alike, rather than guessing", () => {
    const twins = [...group, { id: 5, name: "Kiran" }];
    const result = splitFromSpeech("karen had the biryani", items, twins);
    expect(result.assignments).toEqual({});
    expect(result.doubts.length).toBeGreaterThan(0);
  });

  it("still matches an exact name when two people sound alike", () => {
    const twins = [...group, { id: 5, name: "Kiran" }];
    expect(splitFromSpeech("kiran had the biryani", items, twins).assignments).toEqual({ 2: { 5: 1 } });
  });
});
