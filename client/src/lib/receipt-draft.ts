// The editable draft behind the receipt review screen: what the model read, as strings the user
// can change, plus the totals, the "does it add up" check, and the request that saves it.
// All money is whole paise internally; inputs are rupee strings converted at the edge.
import { paiseToRupeeInput, rupeesToPaise } from "@splittingwisdom/shared";
import type { CreateBillInput, ReceiptExtraction } from "@/hooks/use-bills";

export interface DraftItem {
  key: string;
  name: string;
  /** Rupees, the line total as printed. */
  price: string;
  quantity: string;
  /** Rupees per unit while it's being typed; otherwise derived from price and quantity (see line-item.ts). */
  unit?: string;
  qtyBasis?: string;
  /** The model wasn't sure about this line. */
  low: boolean;
}

export interface ReceiptDraft {
  description: string;
  billDate: string;
  items: DraftItem[];
  tax: string;
  tip: string;
  service: string;
  discount: string;
  /** Signed rupees: "-0.18" for a printed "Round off -0.18". */
  roundOff: string;
  /** What the receipt itself says the total is, in paise (null if it wasn't read). */
  receiptTotal: number | null;
  /** Tax that's already inside the item prices, in paise — shown, never added to the total. */
  taxIncluded: number | null;
  /** True when the model said the whole photo was hard to read. */
  lowOverall: boolean;
}

/** Below this, a gap is rounding noise rather than a mistake (matches the server's check). */
export const MISMATCH_TOLERANCE_PAISE = 50;

let keyCounter = 0;
export const newItemKey = () => `item-${++keyCounter}`;

export function blankItem(): DraftItem {
  return { key: newItemKey(), name: "", price: "", quantity: "1", low: false };
}

/** Rupee text -> paise, or null when it isn't a clean amount. Empty is null too (callers decide what empty means). */
export function parseMoney(input: string, allowNegative = false): number | null {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (cleaned === "") return null;
  if (!allowNegative && cleaned.startsWith("-")) return null;
  try {
    return rupeesToPaise(cleaned);
  } catch {
    return null;
  }
}

const money = (paise: number | null) => (paise === null || paise === 0 ? "" : paiseToRupeeInput(paise));

export function draftFromExtraction(extraction: ReceiptExtraction | null, today: string): ReceiptDraft {
  const date = extraction?.billDate && /^\d{4}-\d{2}-\d{2}$/.test(extraction.billDate) ? extraction.billDate : today;
  const items: DraftItem[] = extraction?.items.length
    ? extraction.items.map((i) => ({
        key: newItemKey(),
        name: i.name,
        price: paiseToRupeeInput(i.price),
        // No quantity read (missing, zero or junk) means one.
        quantity: Number.isInteger(i.quantity) && i.quantity >= 1 ? String(i.quantity) : "1",
        low: i.confidence === "low",
      }))
    : [blankItem()];
  return {
    description: extraction?.merchant ?? "",
    billDate: date,
    items,
    tax: money(extraction?.taxAmount ?? null),
    tip: money(extraction?.tipAmount ?? null),
    service: money(extraction?.serviceFeeAmount ?? null),
    discount: money(extraction?.discountAmount ?? null),
    roundOff: money(extraction?.roundOffAmount ?? null),
    receiptTotal: extraction?.totalAmount ?? null,
    taxIncluded: extraction?.taxIncludedAmount ?? null,
    lowOverall: extraction?.overallConfidence === "low",
  };
}

export interface DraftTotals {
  itemsSubtotal: number;
  tax: number;
  tip: number;
  service: number;
  discount: number;
  roundOff: number;
  grandTotal: number;
  /** Fields whose text isn't a valid amount, so the UI can say which. */
  badFields: string[];
}

export function computeTotals(draft: ReceiptDraft): DraftTotals {
  const badFields: string[] = [];
  const charge = (text: string, label: string, signed = false) => {
    if (text.trim() === "") return 0;
    const value = parseMoney(text, signed);
    if (value === null) {
      badFields.push(label);
      return 0;
    }
    return value;
  };
  const tax = charge(draft.tax, "tax");
  const tip = charge(draft.tip, "tip");
  const service = charge(draft.service, "service charge");
  const discount = charge(draft.discount, "discount");
  const roundOff = charge(draft.roundOff, "round-off", true);
  const itemsSubtotal = draft.items.reduce((sum, item) => sum + (parseMoney(item.price) ?? 0), 0);
  return { itemsSubtotal, tax, tip, service, discount, roundOff, grandTotal: itemsSubtotal + tax + tip + service + roundOff - discount, badFields };
}

export function mismatchOf(draft: ReceiptDraft): { computed: number; receiptTotal: number; delta: number } | null {
  if (draft.receiptTotal === null) return null;
  const { grandTotal } = computeTotals(draft);
  const delta = grandTotal - draft.receiptTotal;
  return Math.abs(delta) < MISMATCH_TOLERANCE_PAISE ? null : { computed: grandTotal, receiptTotal: draft.receiptTotal, delta };
}

/** The round-off that would make the bill add up to the receipt's own total, as signed rupees text. */
export function roundOffToMatchReceipt(draft: ReceiptDraft): string {
  if (draft.receiptTotal === null) return draft.roundOff;
  const without = computeTotals({ ...draft, roundOff: "" }).grandTotal;
  const needed = draft.receiptTotal - without;
  return needed === 0 ? "" : paiseToRupeeInput(needed);
}

export function itemsNeedingReview(draft: ReceiptDraft): DraftItem[] {
  return draft.items.filter((i) => i.low);
}

export type BuildResult = { ok: true; input: CreateBillInput } | { ok: false; message: string };

export function buildCreateBill(
  draft: ReceiptDraft,
  target: { groupId: number | null; payerMemberId: number | null; memberIds: number[]; imagePath: string | null },
): BuildResult {
  if (!draft.description.trim()) return { ok: false, message: "Give the bill a name, like the restaurant." };
  if (target.groupId === null) return { ok: false, message: "Choose which group this bill is for." };
  if (target.payerMemberId === null) return { ok: false, message: "Choose who paid." };
  if (target.memberIds.length === 0) return { ok: false, message: "Choose at least one person to split between." };

  const totals = computeTotals(draft);
  if (totals.badFields.length > 0) return { ok: false, message: `Check the ${totals.badFields[0]} amount.` };

  const items = [];
  for (const [index, item] of draft.items.entries()) {
    const label = item.name.trim() || `Item ${index + 1}`;
    if (!item.name.trim()) return { ok: false, message: `${label} needs a name.` };
    const price = parseMoney(item.price);
    if (price === null || price <= 0) return { ok: false, message: `"${label}" needs a price above zero.` };
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, message: `"${label}" needs a whole-number quantity.` };
    items.push({
      name: item.name.trim(),
      price,
      quantity,
      assignments: target.memberIds.map((memberId) => ({ memberId, splitType: "equal" as const })),
    });
  }
  if (items.length === 0) return { ok: false, message: "Add at least one item." };
  if (totals.grandTotal <= 0) return { ok: false, message: "The total has to be more than zero." };

  // Bills have no round-off field: a minus is a small discount, a plus a small extra charge, so the total stays exact.
  const discountAmount = totals.discount + Math.max(0, -totals.roundOff);
  const serviceFeeAmount = totals.service + Math.max(0, totals.roundOff);

  return {
    ok: true,
    input: {
      groupId: target.groupId,
      description: draft.description.trim(),
      merchant: draft.description.trim(),
      billDate: draft.billDate,
      subtotalAmount: totals.itemsSubtotal,
      taxAmount: totals.tax,
      tipAmount: totals.tip,
      serviceFeeAmount,
      discountAmount,
      paidByMemberId: target.payerMemberId,
      ...(target.imagePath ? { receiptImageUrl: target.imagePath } : {}),
      items,
    },
  };
}
