import { describe, expect, it } from "vitest";
import { GROUP_EXPORT_FORMAT, GROUP_EXPORT_VERSION, rupeesToPaise, type GroupExportFile } from "@splittingwisdom/shared";
import { CSV_COLUMNS, groupExportToCsv, groupExportToRows } from "./export-csv";

const equal = (memberId: number) => ({ memberId, splitType: "equal" as const });
const file: GroupExportFile = {
  format: GROUP_EXPORT_FORMAT,
  version: GROUP_EXPORT_VERSION,
  exportedAt: "2026-11-13T12:00:00.000Z",
  groups: [
    {
      name: "Goa, 2026",
      coverImage: null,
      exportedBy: 1,
      members: [
        { ref: 1, displayName: "Jacob", registered: true },
        { ref: 2, displayName: "Sohil", registered: true },
        { ref: 3, displayName: "=HYPERLINK(\"x\")", registered: false },
      ],
      bills: [
        {
          description: 'Dinner "at the beach"',
          merchant: "Ganbei",
          billDate: "2026-11-10",
          subtotalAmount: 10001,
          taxAmount: 500,
          tipAmount: 0,
          serviceFeeAmount: 0,
          discountAmount: 100,
          paidBy: 1,
          payers: null,
          createdAt: "2026-11-10T12:00:00.000Z",
          items: [
            { name: "Thali", price: 9001, quantity: 1, assignments: [equal(1), equal(2), equal(3)] },
            { name: "Water", price: 1000, quantity: 1, assignments: [] },
          ],
          receipt: null,
        },
      ],
      settlements: [{ payer: 2, recipient: 1, amount: 3000, note: "UPI", settlementDate: "2026-11-12T12:00:00.000Z", createdAt: "2026-11-12T12:00:00.000Z" }],
      nets: [],
    },
  ],
};

describe("the spreadsheet export with several payers", () => {
  // Flights: each bought their own ticket, and Dev (ref 4) paid for Sohil's too but flew nowhere.
  const flights: GroupExportFile = JSON.parse(JSON.stringify(file));
  flights.groups[0].members.push({ ref: 4, displayName: "Dev", registered: true });
  flights.groups[0].bills = [
    {
      ...file.groups[0].bills[0],
      description: "Flights",
      subtotalAmount: 30000,
      taxAmount: 0,
      discountAmount: 0,
      paidBy: 4,
      payers: [{ member: 1, amount: 10000 }, { member: 4, amount: 20000 }],
      items: [
        { name: "Jacob's ticket", price: 10000, quantity: 1, assignments: [equal(1)] },
        { name: "Sohil's ticket", price: 20000, quantity: 1, assignments: [equal(2)] },
      ],
    },
  ];
  flights.groups[0].settlements = [];
  const rows = groupExportToRows(flights);

  it("gives every payer a row with what they paid, even with nothing on the bill", () => {
    expect(rows.map((r) => [r.Person, r.Amount, r.Paid])).toEqual([
      ["Jacob", "100.00", "100.00"],
      ["Sohil", "200.00", "0.00"],
      ["Dev", "0.00", "200.00"],
    ]);
    expect(rows[0]["Paid by"]).toBe("Jacob, Dev");
  });
});

describe("the spreadsheet export", () => {
  const rows = groupExportToRows(file);

  it("has a row per person per bill, one for what nobody had, and one per settlement", () => {
    expect(rows.filter((r) => r.Type === "Share").map((r) => r.Paid)).toEqual(["104.01", "0.00", "0.00"]);
    expect(rows.map((r) => [r.Type, r.Person])).toEqual([
      ["Share", "Jacob"],
      ["Share", "Sohil"],
      ["Share", '=HYPERLINK("x")'],
      ["Unassigned", ""],
      ["Settlement", "Jacob"],
    ]);
    expect(rows[4]).toMatchObject({ "Paid by": "Sohil", Amount: "30.00", Bill: "UPI", Date: "2026-11-12" });
  });

  it("adds each bill's rows up to its total exactly, in plain rupees", () => {
    const billRows = rows.filter((r) => r.Type !== "Settlement");
    const sum = billRows.reduce((total, r) => total + rupeesToPaise(r.Amount), 0);
    expect(sum).toBe(10001 + 500 - 100);
    expect(billRows[0]["Bill total"]).toBe("104.01");
    // Tax and discount go only to the people who had items, so the water nobody had is just its price.
    expect(billRows[3]).toMatchObject({ Items: "Water", Amount: "10.00" });
  });

  it("splits each share into items, tax, tip, service fee and discount that add up", () => {
    for (const r of rows.filter((row) => row.Type === "Share")) {
      const parts = rupeesToPaise(r["Item share"]) + rupeesToPaise(r["Tax share"]) + rupeesToPaise(r["Tip share"]) + rupeesToPaise(r["Service fee share"]) - rupeesToPaise(r["Discount share"]);
      expect(parts).toBe(rupeesToPaise(r.Amount));
      expect(r.Items).toBe("Thali");
    }
  });

  it("quotes commas and quotes, and won't let a spreadsheet run a name as a formula", () => {
    const csv = groupExportToCsv(file);
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines[1]).toContain('"Goa, 2026",Share,2026-11-10');
    expect(lines[1]).toContain('"Dinner ""at the beach"""');
    expect(lines[3]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.startsWith("﻿")).toBe(true);
  });
});
