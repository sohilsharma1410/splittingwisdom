import { format } from "date-fns";

/** Sort orders for a group's bill list. Both put the newest first. */
export type BillSort = "added" | "billDate";

/** Inclusive YYYY-MM-DD bounds on the bill date. Either may be empty (no bound). */
export interface DateRange {
  from: string;
  to: string;
}

export const NO_RANGE: DateRange = { from: "", to: "" };

export interface ListableBill {
  id: number;
  description: string;
  merchant: string | null;
  billDate: string;
  createdAt: string;
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Bills whose date (YYYY-MM-DD, compared as text) falls inside the range. */
export function inDateRange(billDate: string, range: DateRange): boolean {
  // A "from" after "to" is read as the same range typed the other way round.
  const [from, to] = range.from && range.to && range.from > range.to ? [range.to, range.from] : [range.from, range.to];
  return (!from || billDate >= from) && (!to || billDate <= to);
}

/** Bills whose name or merchant contains the search and whose bill date is in range, newest first by the chosen date. */
export function filterAndSortBills<T extends ListableBill>(bills: T[], search: string, sort: BillSort, range: DateRange = NO_RANGE): T[] {
  const query = normalize(search);
  const matching = bills.filter(
    (b) =>
      inDateRange(b.billDate, range) &&
      (!query || normalize(b.description).includes(query) || normalize(b.merchant ?? "").includes(query)),
  );
  const byAdded = (a: T, b: T) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
  // billDate is YYYY-MM-DD, so comparing the text compares the dates. Same day: most recently added first.
  const compare = sort === "billDate" ? (a: T, b: T) => b.billDate.localeCompare(a.billDate) || byAdded(a, b) : byAdded;
  return [...matching].sort(compare);
}

/** The day a bill is listed under: its bill date, or the local day it was added. */
export function billDay(bill: ListableBill, sort: BillSort): string {
  return sort === "billDate" ? bill.billDate : format(new Date(bill.createdAt), "yyyy-MM-dd");
}

/** An already sorted list cut into runs of bills on the same day, for date headings. */
export function groupByDay<T extends ListableBill>(sorted: T[], sort: BillSort): { day: string; bills: T[] }[] {
  const groups: { day: string; bills: T[] }[] = [];
  for (const bill of sorted) {
    const day = billDay(bill, sort);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.bills.push(bill);
    else groups.push({ day, bills: [bill] });
  }
  return groups;
}
