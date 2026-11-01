import { describe, expect, it } from "vitest";
import { assignmentsFromShares, describeShares } from "./voice-assign";

describe("spoken shares", () => {
  it("equal units are an equal split, in member order", () => {
    expect(assignmentsFromShares([{ memberId: 5, units: 1 }, { memberId: 2, units: 1 }])).toEqual([
      { memberId: 2, splitType: "equal" },
      { memberId: 5, splitType: "equal" },
    ]);
  });
  it("different units split by ratio", () => {
    expect(assignmentsFromShares([{ memberId: 1, units: 2 }, { memberId: 4, units: 1 }])).toEqual([
      { memberId: 1, splitType: "ratio", ratio: 2 },
      { memberId: 4, splitType: "ratio", ratio: 1 },
    ]);
  });
  it("names the people, with counts only when they differ", () => {
    const name = (id: number) => (id === 1 ? "Asha" : "Ravi");
    expect(describeShares([{ memberId: 1, units: 1 }, { memberId: 2, units: 1 }], name)).toBe("Asha, Ravi");
    expect(describeShares([{ memberId: 1, units: 2 }, { memberId: 2, units: 1 }], name)).toBe("Asha ×2, Ravi");
  });
});
