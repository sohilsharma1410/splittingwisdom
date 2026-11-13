import { describe, expect, it } from "vitest";
import { filterAndSortBills, type ListableBill } from "./bill-list";

const bill = (id: number, description: string, merchant: string | null, billDate: string, createdAt: string): ListableBill => ({ id, description, merchant, billDate, createdAt });
const bills = [
  bill(1, "Dinner", "Ganbei", "2026-11-10", "2026-11-10T20:00:00Z"),
  bill(2, "Movie night", null, "2026-11-12", "2026-11-11T09:00:00Z"),
  bill(3, "Groceries", "Big  Basket", "2026-11-01", "2026-11-12T08:00:00Z"),
];
const ids = (list: ListableBill[]) => list.map((b) => b.id);

describe("searching and sorting a group's bills", () => {
  it("sorts newest added first by default", () => {
    expect(ids(filterAndSortBills(bills, "", "added"))).toEqual([3, 2, 1]);
  });
  it("sorts by the date on the bill, newest first", () => {
    expect(ids(filterAndSortBills(bills, "", "billDate"))).toEqual([2, 1, 3]);
  });
  it("breaks a tie on the bill date by when it was added", () => {
    const sameDay = [bill(1, "a", null, "2026-11-10", "2026-11-10T08:00:00Z"), bill(2, "b", null, "2026-11-10", "2026-11-10T09:00:00Z")];
    expect(ids(filterAndSortBills(sameDay, "", "billDate"))).toEqual([2, 1]);
  });
  it("finds a bill by name or merchant, ignoring case and extra spaces", () => {
    expect(ids(filterAndSortBills(bills, "  GANBEI ", "added"))).toEqual([1]);
    expect(ids(filterAndSortBills(bills, "movie", "added"))).toEqual([2]);
    expect(ids(filterAndSortBills(bills, "big basket", "added"))).toEqual([3]);
  });
  it("returns nothing when nothing matches, and doesn't change the list it was given", () => {
    const copy = [...bills];
    expect(filterAndSortBills(bills, "xyz", "added")).toEqual([]);
    filterAndSortBills(bills, "", "billDate");
    expect(bills).toEqual(copy);
  });
});
