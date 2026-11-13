import { format } from "date-fns";
import {
  billPayments,
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
// "Unassigned" row. Settlements get one row each. Filter Type = Share and Person = you: the Amount
// column adds up to your share and the Paid column to what you paid. Someone who paid towards a
// bill but had nothing on it still gets a row, with a share of 0.

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
  "Paid",
] as const;

/** Columns we fill with numbers ourselves, never with typed text. */
const AMOUNT_COLUMNS = new Set<string>(["Bill total", "Item share", "Tax share", "Tip share", "Service fee share", "Discount share", "Amount", "Paid"]);

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
    const blank = { Group: group.name, Merchant: "", Items: "", "Item share": "", "Tax share": "", "Tip share": "", "Service fee share": "", "Discount share": "", Paid: "" };

    for (const bill of group.bills) {
      const total = exportedBillGrandTotal(bill);
      const forBalance = {
        paidByMemberId: bill.paidBy,
        payers: bill.payers ? bill.payers.map((p) => ({ memberId: p.member, amount: p.amount })) : null,
        taxAmount: bill.taxAmount,
        tipAmount: bill.tipAmount,
        serviceFeeAmount: bill.serviceFeeAmount,
        discountAmount: bill.discountAmount,
        items: bill.items.map((item) => ({ price: item.price, assignments: item.assignments })),
      };
      const paid = new Map(billPayments(forBalance, total).map((p) => [p.memberId, p.amount]));
      const billFields = {
        Date: bill.billDate,
        "Added on": day(bill.createdAt),
        Bill: bill.description,
        Merchant: bill.merchant ?? "",
        "Paid by": bill.payers ? bill.payers.map((p) => nameOf.get(p.member) ?? "").join(", ") : (nameOf.get(bill.paidBy) ?? ""),
        "Bill total": rupees(total),
      };
      const breakdown = computeBillBreakdown(forBalance);
      // A payer who had nothing on the bill still gets a row, so the Paid column adds up.
      for (const memberId of paid.keys()) {
        if (!breakdown.some((row) => row.memberId === memberId)) {
          breakdown.push({ memberId, itemShare: 0, taxShare: 0, tipShare: 0, serviceFeeShare: 0, discountShare: 0, total: 0 });
        }
      }
      breakdown.sort((a, b) => a.memberId - b.memberId);
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
          Paid: rupees(paid.get(share.memberId) ?? 0),
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
