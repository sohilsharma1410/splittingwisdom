import { billGrandTotal, summarizeMember, type BillForSummary, type BillPayer, type ExportedGroup, type SplitType } from "@splittingwisdom/shared";

// Building the export form of a group. No database access, so it is unit tested directly.

/** A group as loaded from the database for export. */
export interface LoadedGroup {
  name: string;
  coverImage: string | null;
  members: { id: number; userId: number | null; displayName: string }[];
  bills: {
    id: number;
    description: string;
    merchant: string | null;
    billDate: string;
    subtotalAmount: number;
    taxAmount: number;
    tipAmount: number;
    serviceFeeAmount: number;
    discountAmount: number;
    paidByMemberId: number;
    payers: BillPayer[] | null;
    receiptImageUrl: string | null;
    createdAt: Date;
    items: {
      id: number;
      name: string;
      price: number;
      quantity: number;
      sortOrder: number;
      assignments: {
        memberId: number;
        splitType: SplitType;
        percentage: number | null;
        ratio: number | null;
        customAmount: number | null;
      }[];
    }[];
  }[];
  settlements: {
    payerMemberId: number;
    recipientMemberId: number;
    amount: number;
    note: string | null;
    settlementDate: Date;
    createdAt: Date;
  }[];
}

export type ExportedReceipts = Map<number, { mimeType: string; base64: string }>;

/**
 * Turns a loaded group into its export form. Members get refs 1, 2, 3... in id order. The
 * recorded nets are computed from the database rows, not from the export, so an import is
 * checked against what the source database said.
 */
export function buildExportedGroup(group: LoadedGroup, exporterMemberId: number, receipts: ExportedReceipts): ExportedGroup {
  const members = [...group.members].sort((a, b) => a.id - b.id);
  const refOf = new Map(members.map((m, index) => [m.id, index + 1]));
  const toRef = (memberId: number) => {
    const ref = refOf.get(memberId);
    if (ref === undefined) throw new Error(`Member ${memberId} isn't in group "${group.name}".`);
    return ref;
  };

  const billsInOrder = [...group.bills].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  const dbBills: BillForSummary[] = billsInOrder.map((bill) => ({
    paidByMemberId: bill.paidByMemberId,
    payers: bill.payers,
    taxAmount: bill.taxAmount,
    tipAmount: bill.tipAmount,
    serviceFeeAmount: bill.serviceFeeAmount,
    discountAmount: bill.discountAmount,
    grandTotal: billGrandTotal(bill),
    items: bill.items.map((item) => ({ price: item.price, assignments: item.assignments })),
  }));
  const dbSettlements = group.settlements.map((s) => ({ payerMemberId: s.payerMemberId, recipientMemberId: s.recipientMemberId, amount: s.amount }));

  return {
    name: group.name,
    coverImage: group.coverImage,
    exportedBy: toRef(exporterMemberId),
    members: members.map((m) => ({ ref: toRef(m.id), displayName: m.displayName, registered: m.userId !== null })),
    bills: billsInOrder.map((bill) => {
      const receipt = receipts.get(bill.id);
      return {
        description: bill.description,
        merchant: bill.merchant,
        billDate: bill.billDate,
        subtotalAmount: bill.subtotalAmount,
        taxAmount: bill.taxAmount,
        tipAmount: bill.tipAmount,
        serviceFeeAmount: bill.serviceFeeAmount,
        discountAmount: bill.discountAmount,
        paidBy: toRef(bill.paidByMemberId),
        payers: bill.payers ? bill.payers.map((p) => ({ member: toRef(p.memberId), amount: p.amount })) : null,
        createdAt: bill.createdAt.toISOString(),
        items: [...bill.items]
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
          .map((item) => ({
            name: item.name,
            price: item.price,
            quantity: item.quantity,
            assignments: item.assignments.map((a) => ({
              memberId: toRef(a.memberId),
              splitType: a.splitType,
              percentage: a.percentage,
              ratio: a.ratio,
              customAmount: a.customAmount,
            })),
          })),
        receipt: receipt ? { mimeType: receipt.mimeType as "image/jpeg" | "image/png" | "image/webp", base64: receipt.base64 } : null,
      };
    }),
    settlements: group.settlements.map((s) => ({
      payer: toRef(s.payerMemberId),
      recipient: toRef(s.recipientMemberId),
      amount: s.amount,
      note: s.note,
      settlementDate: s.settlementDate.toISOString(),
      createdAt: s.createdAt.toISOString(),
    })),
    nets: members.map((m) => ({ member: toRef(m.id), net: summarizeMember(dbBills, dbSettlements, m.id).net })),
  };
}

