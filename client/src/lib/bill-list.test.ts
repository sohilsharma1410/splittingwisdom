import { describe, expect, it } from "vitest";
import { filterAndSortBills, groupByDay, type ListableBill } from "./bill-list";

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

describe("date headings and the date range", () => {
  it("only keeps bills dated inside the range, both ends included", () => {
    expect(ids(filterAndSortBills(bills, "", "billDate", { from: "2026-11-10", to: "2026-11-12" }))).toEqual([2, 1]);
    expect(ids(filterAndSortBills(bills, "", "billDate", { from: "2026-11-11", to: "" }))).toEqual([2]);
    expect(ids(filterAndSortBills(bills, "", "billDate", { from: "", to: "2026-11-01" }))).toEqual([3]);
  });

  it("reads a range typed backwards the right way round, and combines with search", () => {
    expect(ids(filterAndSortBills(bills, "", "billDate", { from: "2026-11-12", to: "2026-11-10" }))).toEqual([2, 1]);
    expect(ids(filterAndSortBills(bills, "ganbei", "billDate", { from: "2026-11-11", to: "" }))).toEqual([]);
  });

  it("groups a sorted list under one heading per day, by the date it's sorted by", () => {
    const sameDay = [...bills, bill(4, "Lunch", null, "2026-11-10", "2026-11-10T13:00:00Z")];
    const byBillDate = groupByDay(filterAndSortBills(sameDay, "", "billDate"), "billDate");
    expect(byBillDate.map((g) => [g.day, ids(g.bills)])).toEqual([
      ["2026-11-12", [2]],
      ["2026-11-10", [1, 4]],
      ["2026-11-01", [3]],
    ]);
    const byAdded = groupByDay(filterAndSortBills(sameDay, "", "added"), "added");
    expect(byAdded.map((g) => g.bills.length).reduce((a, b) => a + b, 0)).toBe(4);
    expect(new Set(byAdded.map((g) => g.day)).size).toBe(byAdded.length);
  });
});
