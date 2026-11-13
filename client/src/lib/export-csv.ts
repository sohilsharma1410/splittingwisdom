import { format } from "date-fns";
import {
  computeBillBreakdown,
  computeItemShares,
  exportedBillGrandTotal,
  paiseToRupeeInput,
  type GroupExportFile,
} from "@splittingwisdom/shared";

// A spreadsheet view of a group export: for reading, sorting and filtering, not for importing.
//
// One row per person per bill, with their share split into items, tax, tip, service fee and
// discount. A bill's rows add up to its total exactly: anything assigned to nobody gets its own
// "Unassigned" row. Settlements get one row each. Filter Type = Share and Person = you, and the
// Amount column adds up to your share.

export const CSV_COLUMNS = [
  "Group",
  "Type",
  "Date",
  "Added on",
  "Bill",
  "Merchant",
  "Paid by",
  "Bill total",
  "Person",
  "Items",
  "Item share",
  "Tax share",
  "Tip share",
  "Service fee share",
  "Discount share",
  "Amount",
] as const;

/** Columns we fill with numbers ourselves, never with typed text. */
const AMOUNT_COLUMNS = new Set<string>(["Bill total", "Item share", "Tax share", "Tip share", "Service fee share", "Discount share", "Amount"]);

type Row = Record<(typeof CSV_COLUMNS)[number], string>;

/** Rupees as plain "1234.50" so spreadsheets read them as numbers. Computed from integer paise. */
const rupees = (paise: number) => paiseToRupeeInput(paise);
const day = (iso: string) => format(new Date(iso), "yyyy-MM-dd");

/**
 * A text cell, quoted when needed. Text a spreadsheet would run as a formula (starting with =, +,
 * -, @, tab or return) gets a leading apostrophe: bill names are typed by anyone in the group.
 */
function cell(value: string, isAmount: boolean): string {
  const safe = !isAmount && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function groupExportToRows(file: GroupExportFile): Row[] {
  const rows: Row[] = [];
  for (const group of file.groups) {
    const nameOf = new Map(group.members.map((m) => [m.ref, m.displayName]));
    const blank = { Group: group.name, Merchant: "", Items: "", "Item share": "", "Tax share": "", "Tip share": "", "Service fee share": "", "Discount share": "" };

    for (const bill of group.bills) {
      const total = exportedBillGrandTotal(bill);
      const billFields = {
        Date: bill.billDate,
        "Added on": day(bill.createdAt),
        Bill: bill.description,
        Merchant: bill.merchant ?? "",
        "Paid by": nameOf.get(bill.paidBy) ?? "",
        "Bill total": rupees(total),
      };
      const breakdown = computeBillBreakdown({
        paidByMemberId: bill.paidBy,
        taxAmount: bill.taxAmount,
        tipAmount: bill.tipAmount,
        serviceFeeAmount: bill.serviceFeeAmount,
        discountAmount: bill.discountAmount,
        items: bill.items.map((item) => ({ price: item.price, assignments: item.assignments })),
      });
      const itemsOf = (ref: number) =>
        bill.items.filter((item) => computeItemShares(item).has(ref)).map((item) => item.name).join("; ");

      let assigned = 0;
      for (const share of breakdown) {
        assigned += share.total;
        rows.push({
          ...blank,
          ...billFields,
          Type: "Share",
          Person: nameOf.get(share.memberId) ?? "",
          Items: itemsOf(share.memberId),
          "Item share": rupees(share.itemShare),
          "Tax share": rupees(share.taxShare),
          "Tip share": rupees(share.tipShare),
          "Service fee share": rupees(share.serviceFeeShare),
          "Discount share": rupees(share.discountShare),
          Amount: rupees(share.total),
        });
      }
      if (total - assigned !== 0) {
        rows.push({
          ...blank,
          ...billFields,
          Type: "Unassigned",
          Person: "",
          Items: bill.items.filter((item) => item.assignments.length === 0).map((item) => item.name).join("; "),
          Amount: rupees(total - assigned),
        });
      }
    }

    for (const s of group.settlements) {
      rows.push({
        ...blank,
        Type: "Settlement",
        Date: day(s.settlementDate),
        "Added on": day(s.createdAt),
        Bill: s.note ?? "",
        "Paid by": nameOf.get(s.payer) ?? "",
        "Bill total": "",
        Person: nameOf.get(s.recipient) ?? "",
        Amount: rupees(s.amount),
      });
    }
  }
  return rows;
}

/** The CSV text, with a byte-order mark so Excel reads names in any script correctly. */
export function groupExportToCsv(file: GroupExportFile): string {
  const lines = [CSV_COLUMNS.join(","), ...groupExportToRows(file).map((row) => CSV_COLUMNS.map((c) => cell(row[c], AMOUNT_COLUMNS.has(c))).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}
