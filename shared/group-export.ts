import { z } from "zod";
import { billItemInputSchema, payersProblem } from "./schema.js";
import { summarizeMember, type BillForSummary, type SettlementForBalance } from "./lib/balance.js";

// ---------------------------------------------------------------------------
// The group export file: one or more groups with their members, bills, items,
// who-had-what and settlements. Amounts are integer paise, as everywhere.
//
// Database ids never appear in the file. Each member gets a `ref` (1, 2, 3...)
// local to their group, and everything that points at a member uses it.
// Each group also records every member's net balance as it was when exported,
// so an import can prove the money came through unchanged.
// ---------------------------------------------------------------------------

export const GROUP_EXPORT_FORMAT = "splittingwisdom-groups";
/** Version 2 added several payers per bill. Version 1 files (one payer each) still import. */
export const GROUP_EXPORT_VERSION = 2;
export const RECEIPT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** A receipt image is at most 10 MB, which is about 13.4 MB as base64. */
const MAX_RECEIPT_BASE64_LENGTH = 14_000_000;

const ref = z.number().int().positive();
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)), "Use a valid date");
const timestamp = z.string().refine((t) => !Number.isNaN(Date.parse(t)), "Use a valid date and time");
const paise = z.number().int("Amounts must be whole paise");

export const exportedMemberSchema = z.object({
  ref,
  displayName: z.string().trim().min(1).max(100),
  /** Had an account when exported. Imported members never get an account linked, except the importer. */
  registered: z.boolean(),
});

export const exportedReceiptSchema = z.object({
  mimeType: z.enum(RECEIPT_MIME_TYPES),
  base64: z.string().min(1).max(MAX_RECEIPT_BASE64_LENGTH).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Receipt image data is damaged"),
});

export const exportedBillSchema = z.object({
  description: z.string().min(1).max(200),
  merchant: z.string().max(200).nullable(),
  billDate: dateOnly,
  subtotalAmount: paise.positive(),
  taxAmount: paise.nonnegative(),
  tipAmount: paise.nonnegative(),
  serviceFeeAmount: paise.nonnegative(),
  discountAmount: paise.nonnegative(),
  /** The ref of the member who paid; with several payers, the one who paid most. */
  paidBy: ref,
  /** Several payers (version 2). null: paidBy paid it all. */
  payers: z
    .array(z.object({ member: ref, amount: paise.positive() }))
    .min(2)
    .nullable()
    .default(null),
  /** When the bill was added: kept so "sort by date added" survives a round trip. */
  createdAt: timestamp,
  /** Each assignment's memberId is a member ref. The same rules as a bill added in the app. */
  items: z.array(billItemInputSchema).min(1).max(500),
  /** Only when receipt photos were included and the bill had one. */
  receipt: exportedReceiptSchema.nullable(),
});

export const exportedSettlementSchema = z.object({
  payer: ref,
  recipient: ref,
  amount: paise.positive(),
  note: z.string().max(200).nullable(),
  settlementDate: timestamp,
  createdAt: timestamp,
});

export const exportedGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    coverImage: z.string().max(500).nullable(),
    /** The ref of the member who exported it: the importer's default "this is me". */
    exportedBy: ref,
    members: z.array(exportedMemberSchema).min(1).max(200),
    bills: z.array(exportedBillSchema).max(10_000),
    settlements: z.array(exportedSettlementSchema).max(10_000),
    /** Every member's net balance at export time (positive: the others owe them). */
    nets: z.array(z.object({ member: ref, net: paise })),
  })
  .superRefine((group, ctx) => {
    const refs = new Set(group.members.map((m) => m.ref));
    if (refs.size !== group.members.length) {
      ctx.addIssue({ code: "custom", path: ["members"], message: "Two members share the same ref." });
      return;
    }
    const known = (r: number) => refs.has(r);
    if (!known(group.exportedBy)) ctx.addIssue({ code: "custom", path: ["exportedBy"], message: "Unknown member." });
    group.bills.forEach((bill, b) => {
      if (!known(bill.paidBy)) ctx.addIssue({ code: "custom", path: ["bills", b, "paidBy"], message: `"${bill.description}" was paid by an unknown member.` });
      if (bill.payers) {
        const members = bill.payers.map((p) => p.member);
        if (!members.every(known) || new Set(members).size !== members.length) {
          ctx.addIssue({ code: "custom", path: ["bills", b, "payers"], message: `"${bill.description}" lists an unknown payer, or one payer twice.` });
        }
        const problem = payersProblem(bill.payers.map((p) => ({ memberId: p.member, amount: p.amount })), exportedBillGrandTotal(bill));
        if (problem) ctx.addIssue({ code: "custom", path: ["bills", b, "payers"], message: `"${bill.description}": ${problem}` });
      }
      bill.items.forEach((item, i) => {
        if (item.assignments.some((a) => !known(a.memberId))) {
          ctx.addIssue({ code: "custom", path: ["bills", b, "items", i], message: `"${item.name}" is assigned to an unknown member.` });
        }
        if (new Set(item.assignments.map((a) => a.memberId)).size !== item.assignments.length) {
          ctx.addIssue({ code: "custom", path: ["bills", b, "items", i], message: `"${item.name}" lists the same person twice.` });
        }
      });
    });
    group.settlements.forEach((s, i) => {
      if (!known(s.payer) || !known(s.recipient) || s.payer === s.recipient) {
        ctx.addIssue({ code: "custom", path: ["settlements", i], message: "A settlement names an unknown member, or someone paying themselves." });
      }
    });
    const netRefs = group.nets.map((n) => n.member);
    if (netRefs.length !== refs.size || new Set(netRefs).size !== refs.size || !netRefs.every(known)) {
      ctx.addIssue({ code: "custom", path: ["nets"], message: "The recorded balances don't list every member exactly once." });
    }
  });

export const groupExportFileSchema = z.object({
  format: z.literal(GROUP_EXPORT_FORMAT, { message: "This isn't a SplittingWisdom group export." }),
  version: z.union([z.literal(1), z.literal(GROUP_EXPORT_VERSION)], { message: "This export comes from a newer version of the app." }),
  exportedAt: timestamp,
  groups: z.array(exportedGroupSchema).min(1).max(50),
});

export type ExportedMember = z.infer<typeof exportedMemberSchema>;
export type ExportedBill = z.infer<typeof exportedBillSchema>;
export type ExportedSettlement = z.infer<typeof exportedSettlementSchema>;
export type ExportedGroup = z.infer<typeof exportedGroupSchema>;
export type GroupExportFile = z.infer<typeof groupExportFileSchema>;

/** Export request: which groups, and whether to include receipt photos. */
export const groupExportRequestSchema = z.object({
  ids: z
    .string()
    .regex(/^\d+(,\d+)*$/, "Pick at least one group")
    .transform((s) => [...new Set(s.split(",").map(Number))])
    .refine((ids) => ids.length <= 50, "Export at most 50 groups at a time"),
  receipts: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

/** Import request: for each group in the file, in order, the ref of the member who is the importer. */
export const groupImportChoicesSchema = z.array(ref).min(1).max(50);

export function exportedBillGrandTotal(bill: Pick<ExportedBill, "subtotalAmount" | "taxAmount" | "tipAmount" | "serviceFeeAmount" | "discountAmount">): number {
  return bill.subtotalAmount + bill.taxAmount + bill.tipAmount + bill.serviceFeeAmount - bill.discountAmount;
}

/** The group's bills and settlements in the balance engine's shapes, keyed by member ref. */
function forBalance(group: ExportedGroup): { bills: BillForSummary[]; settlements: SettlementForBalance[] } {
  return {
    bills: group.bills.map((bill) => ({
      paidByMemberId: bill.paidBy,
      payers: bill.payers ? bill.payers.map((p) => ({ memberId: p.member, amount: p.amount })) : null,
      taxAmount: bill.taxAmount,
      tipAmount: bill.tipAmount,
      serviceFeeAmount: bill.serviceFeeAmount,
      discountAmount: bill.discountAmount,
      grandTotal: exportedBillGrandTotal(bill),
      items: bill.items.map((item) => ({ price: item.price, assignments: item.assignments })),
    })),
    settlements: group.settlements.map((s) => ({ payerMemberId: s.payer, recipientMemberId: s.recipient, amount: s.amount })),
  };
}

/** Every member's net balance computed from the group's own bills and settlements, by ref. */
export function computeExportedNets(group: ExportedGroup): Map<number, number> {
  const { bills, settlements } = forBalance(group);
  return new Map(group.members.map((m) => [m.ref, summarizeMember(bills, settlements, m.ref).net]));
}

/**
 * Groups whose bills don't produce the balances recorded in the file: the file was edited or
 * damaged. Returns their names; empty means every group checks out to the paisa.
 */
export function groupsWithMismatchedNets(file: GroupExportFile): string[] {
  return file.groups
    .filter((group) => {
      const computed = computeExportedNets(group);
      return group.nets.some((n) => computed.get(n.member) !== n.net);
    })
    .map((group) => group.name);
}

/** Totals for the import preview. */
export function exportedGroupTotals(group: ExportedGroup): { billCount: number; spent: number; receiptCount: number } {
  return {
    billCount: group.bills.length,
    spent: group.bills.reduce((sum, bill) => sum + exportedBillGrandTotal(bill), 0),
    receiptCount: group.bills.filter((bill) => bill.receipt !== null).length,
  };
}
