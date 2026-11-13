/** Sort orders for a group's bill list. Both put the newest first. */
export type BillSort = "added" | "billDate";

export interface ListableBill {
  id: number;
  description: string;
  merchant: string | null;
  billDate: string;
  createdAt: string;
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Bills whose name or merchant contains the search, sorted newest first by the chosen date. */
export function filterAndSortBills<T extends ListableBill>(bills: T[], search: string, sort: BillSort): T[] {
  const query = normalize(search);
  const matching = query
    ? bills.filter((b) => normalize(b.description).includes(query) || normalize(b.merchant ?? "").includes(query))
    : bills;
  const byAdded = (a: T, b: T) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
  // billDate is YYYY-MM-DD, so comparing the text compares the dates. Same day: most recently added first.
  const compare = sort === "billDate" ? (a: T, b: T) => b.billDate.localeCompare(a.billDate) || byAdded(a, b) : byAdded;
  return [...matching].sort(compare);
}
