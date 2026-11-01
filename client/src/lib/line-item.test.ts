import { describe, expect, it } from "vitest";
import { exactUnitPaise, unitText, withQuantity, withTotal, withUnit } from "./line-item";

const row = (price: string, quantity: string, unit?: string) => ({ price, quantity, unit });

describe("line item", () => {
  it("derives an exact unit cost and leaves uneven ones blank", () => {
    expect(unitText(row("550.00", "11"))).toBe("50.00");
    expect(exactUnitPaise("100.00", "3")).toBeNull();
    expect(unitText(row("100.00", "3"))).toBe("");
  });
  it("showing a row never changes its total", () => {
    const r = row("100.00", "3");
    unitText(r);
    expect(r.price).toBe("100.00");
  });
  it("quantity change multiplies the unit cost", () => {
    expect(withQuantity(row("60.00", "4"), "5").price).toBe("75.00");
    expect(withQuantity(row("55.00", "1"), "11").price).toBe("605.00");
  });
  it("quantity change on an uneven line keeps the cost per unit", () => {
    expect(withQuantity(row("100.00", "3"), "6").price).toBe("200.00");
    expect(withQuantity(row("100.00", "3"), "2").price).toBe("66.67");
  });
  it("an empty or invalid quantity leaves the total alone", () => {
    expect(withQuantity(row("60.00", "4"), "").price).toBe("60.00");
    expect(withQuantity(row("60.00", "4"), "0").price).toBe("60.00");
  });
  it("unit cost change sets total = unit x quantity, in paise", () => {
    expect(withUnit(row("60.00", "4"), "17.50").price).toBe("70.00");
    expect(withUnit(row("10.00", "3"), "0.10").price).toBe("0.30");
    expect(withUnit(row("60.00", "4"), "abc").price).toBe("60.00");
  });
  it("typing a total re-derives the unit cost", () => {
    const edited = withTotal(row("60.00", "4", "99"), "80.00");
    expect(edited.unit).toBeUndefined();
    expect(unitText(edited)).toBe("20.00");
  });
  it("clearing the quantity box and retyping keeps the cost each, not the total", () => {
    const cleared = withQuantity(row("550.00", "11"), "");
    expect(cleared.price).toBe("550.00"); // untouched while empty
    expect(withQuantity(cleared, "1").price).toBe("50.00");
    expect(withQuantity(withQuantity(cleared, "1"), "12").price).toBe("600.00");
    expect(withQuantity(withQuantity(row("659.00", "1"), ""), "2").price).toBe("1318.00");
  });
  it("same for an uneven line", () => {
    const cleared = withQuantity(row("100.00", "3"), "");
    expect(withQuantity(cleared, "6").price).toBe("200.00");
  });
});
