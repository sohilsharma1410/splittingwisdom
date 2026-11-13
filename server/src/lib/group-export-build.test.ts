import { describe, expect, it } from "vitest";
import {
  computeExportedNets,
  exportedGroupTotals,
  groupExportFileSchema,
  groupsWithMismatchedNets,
  GROUP_EXPORT_FORMAT,
  GROUP_EXPORT_VERSION,
  type GroupExportFile,
} from "@splittingwisdom/shared";
import { buildExportedGroup, type LoadedGroup } from "./group-export-build.js";

const equal = (memberId: number) => ({ memberId, splitType: "equal" as const, percentage: null, ratio: null, customAmount: null });
const bill = (over: Partial<LoadedGroup["bills"][number]>): LoadedGroup["bills"][number] => ({
  id: 1,
  description: "Dinner",
  merchant: "Ganbei",
  billDate: "2026-11-10",
  subtotalAmount: 100000,
  taxAmount: 5000,
  tipAmount: 0,
  serviceFeeAmount: 0,
  discountAmount: 1000,
  paidByMemberId: 41,
  payers: null,
  receiptImageUrl: null,
  createdAt: new Date("2026-11-10T20:00:00Z"),
  items: [],
  ...over,
});

// Database member ids 41, 57 and 60: Jacob (the exporter), Sohil, and Ravi who never signed up.
const group: LoadedGroup = {
  name: "Goa",
  coverImage: null,
  members: [
    { id: 57, userId: 9, displayName: "Sohil" },
    { id: 41, userId: 3, displayName: "Jacob" },
    { id: 60, userId: null, displayName: "Ravi" },
  ],
  bills: [
    bill({
      id: 8,
      createdAt: new Date("2026-11-11T09:00:00Z"),
      description: "Movie",
      merchant: null,
      paidByMemberId: 57,
      subtotalAmount: 90000,
      taxAmount: 0,
      discountAmount: 0,
      items: [{ id: 1, name: "Tickets", price: 90000, quantity: 3, sortOrder: 0, assignments: [equal(41), equal(57), equal(60)] }],
    }),
    bill({
      id: 7,
      receiptImageUrl: "3/abcdefghijklmnop.jpg",
      items: [
        { id: 3, name: "Biryani", price: 70000, quantity: 1, sortOrder: 1, assignments: [{ memberId: 41, splitType: "percentage", percentage: 60, ratio: null, customAmount: null }, { memberId: 60, splitType: "percentage", percentage: 40, ratio: null, customAmount: null }] },
        { id: 2, name: "Naan", price: 20000, quantity: 2, sortOrder: 0, assignments: [{ memberId: 57, splitType: "custom", percentage: null, ratio: null, customAmount: 20000 }] },
        { id: 4, name: "Dessert", price: 10000, quantity: 1, sortOrder: 2, assignments: [] },
      ],
    }),
  ],
  settlements: [{ payerMemberId: 60, recipientMemberId: 41, amount: 12345, note: "upi", settlementDate: new Date("2026-11-12T00:00:00Z"), createdAt: new Date("2026-11-12T10:00:00Z") }],
};

const receipts = new Map([[7, { mimeType: "image/jpeg", base64: Buffer.from("not really a jpeg").toString("base64") }]]);
const fileOf = (built: ReturnType<typeof buildExportedGroup>): GroupExportFile => ({
  format: GROUP_EXPORT_FORMAT,
  version: GROUP_EXPORT_VERSION,
  exportedAt: "2026-11-13T00:00:00.000Z",
  groups: [built],
});
/** What an import sees: the file after being written out and read back. */
const roundTrip = (file: GroupExportFile) => groupExportFileSchema.parse(JSON.parse(JSON.stringify(file)));

describe("exporting a group", () => {
  const exported = buildExportedGroup(group, 41, receipts);

  it("numbers members 1, 2, 3 by database id, and never includes database ids", () => {
    expect(exported.members).toEqual([
      { ref: 1, displayName: "Jacob", registered: true },
      { ref: 2, displayName: "Sohil", registered: true },
      { ref: 3, displayName: "Ravi", registered: false },
    ]);
    expect(exported.exportedBy).toBe(1);
    expect(JSON.stringify(exported)).not.toMatch(/"(id|userId|memberId)":\s*(41|57|60|9)\b/);
  });

  it("puts bills in the order they were added and items in their saved order", () => {
    expect(exported.bills.map((b) => b.description)).toEqual(["Dinner", "Movie"]);
    expect(exported.bills[0].items.map((i) => i.name)).toEqual(["Naan", "Biryani", "Dessert"]);
    expect(exported.bills[0].items[1].assignments).toEqual([
      { memberId: 1, splitType: "percentage", percentage: 60, ratio: null, customAmount: null },
      { memberId: 3, splitType: "percentage", percentage: 40, ratio: null, customAmount: null },
    ]);
  });

  it("includes a receipt photo only when one was read, and keeps settlements with their notes", () => {
    expect(exported.bills[0].receipt?.mimeType).toBe("image/jpeg");
    expect(exported.bills[1].receipt).toBeNull();
    expect(buildExportedGroup(group, 41, new Map()).bills[0].receipt).toBeNull();
    expect(exported.settlements).toEqual([{ payer: 3, recipient: 1, amount: 12345, note: "upi", settlementDate: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T10:00:00.000Z" }]);
  });

  it("records nets that add up to zero and that the file's own bills reproduce exactly", () => {
    expect(exported.nets.reduce((sum, n) => sum + n.net, 0)).toBe(0);
    const recomputed = computeExportedNets(roundTrip(fileOf(exported)).groups[0]);
    for (const { member, net } of exported.nets) expect(recomputed.get(member)).toBe(net);
    expect(groupsWithMismatchedNets(roundTrip(fileOf(exported)))).toEqual([]);
  });

  it("survives being written out and read back unchanged", () => {
    expect(roundTrip(fileOf(exported))).toEqual(fileOf(exported));
  });

  it("totals the group for the import preview", () => {
    expect(exportedGroupTotals(exported)).toEqual({ billCount: 2, spent: 104000 + 90000, receiptCount: 1 });
  });

  it("refuses a bill paid by someone who isn't in the group", () => {
    expect(() => buildExportedGroup({ ...group, bills: [bill({ paidByMemberId: 999 })] }, 41, new Map())).toThrow(/isn't in group/);
  });
});

describe("checking a file before import", () => {
  const good = fileOf(buildExportedGroup(group, 41, receipts));
  const edited = (change: (file: GroupExportFile) => void) => {
    const copy = JSON.parse(JSON.stringify(good)) as GroupExportFile;
    change(copy);
    return copy;
  };
  const problem = (file: unknown) => {
    const result = groupExportFileSchema.safeParse(file);
    return result.success ? null : result.error.issues[0].message;
  };

  it("catches an edited amount, because the recorded balances no longer match", () => {
    const file = roundTrip(edited((f) => (f.groups[0].bills[1].items[0].price = 95000)));
    expect(groupsWithMismatchedNets(file)).toEqual(["Goa"]);
  });

  it("rejects something that isn't an export, or comes from a newer version", () => {
    expect(problem({ hello: "world" })).toMatch(/isn't a SplittingWisdom group export/);
    expect(problem(edited((f) => ((f as { version: number }).version = 3)))).toMatch(/newer version/);
  });

  it("applies the app's own split rules: percentages must make 100", () => {
    expect(problem(edited((f) => (f.groups[0].bills[0].items[1].assignments[0].percentage = 50)))).toMatch(/short of 100/);
  });

  it("rejects people who aren't in the group, fractional paise and damaged photos", () => {
    expect(problem(edited((f) => (f.groups[0].bills[0].paidBy = 9)))).toMatch(/unknown member/);
    expect(problem(edited((f) => (f.groups[0].settlements[0].recipient = 3)))).toMatch(/paying themselves/);
    expect(problem(edited((f) => (f.groups[0].bills[0].taxAmount = 10.5)))).toMatch(/whole paise/);
    expect(problem(edited((f) => (f.groups[0].bills[0].receipt!.base64 = "<script>")))).toMatch(/damaged/);
    expect(problem(edited((f) => f.groups[0].nets.pop()))).toMatch(/every member exactly once/);
  });
});

describe("exporting a bill several people paid", () => {
  // Jacob (41) and Ravi (60) each paid for their own ticket; Sohil (57) paid nothing.
  const flights: LoadedGroup = {
    ...group,
    settlements: [],
    bills: [
      bill({
        id: 9,
        description: "Flights",
        subtotalAmount: 30000,
        taxAmount: 0,
        discountAmount: 0,
        paidByMemberId: 60,
        payers: [{ memberId: 41, amount: 10000 }, { memberId: 60, amount: 20000 }],
        items: [
          { id: 5, name: "Jacob", price: 10000, quantity: 1, sortOrder: 0, assignments: [equal(41)] },
          { id: 6, name: "Ravi", price: 20000, quantity: 1, sortOrder: 1, assignments: [equal(60)] },
        ],
      }),
    ],
  };
  const exported = buildExportedGroup(flights, 41, new Map());

  it("writes the payers by ref, and nobody owes anybody", () => {
    expect(exported.bills[0].payers).toEqual([{ member: 1, amount: 10000 }, { member: 3, amount: 20000 }]);
    expect(exported.bills[0].paidBy).toBe(3);
    expect(exported.nets.map((n) => n.net)).toEqual([0, 0, 0]);
    expect(groupsWithMismatchedNets(roundTrip(fileOf(exported)))).toEqual([]);
  });

  it("rejects a file whose payers don't add up to the bill", () => {
    const file = JSON.parse(JSON.stringify(fileOf(exported))) as GroupExportFile;
    file.groups[0].bills[0].payers![0].amount = 9999;
    const result = groupExportFileSchema.safeParse(file);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0].message).toMatch(/short of the bill/);
  });

  it("still reads a version 1 file, where bills have no payers field", () => {
    const v1 = JSON.parse(JSON.stringify(fileOf(buildExportedGroup(group, 41, new Map()))));
    v1.version = 1;
    for (const b of v1.groups[0].bills) delete b.payers;
    const parsed = groupExportFileSchema.parse(v1);
    expect(parsed.groups[0].bills.every((b) => b.payers === null)).toBe(true);
    expect(groupsWithMismatchedNets(parsed)).toEqual([]);
  });
});
