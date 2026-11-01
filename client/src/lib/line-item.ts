// Quantity, unit cost and line total for one item row. The line total is what gets saved
// (bill_items.price) and what balances use, so it is the source of truth: a row is only
// recalculated when someone edits its quantity or unit cost, never just by being shown.
// All money is whole paise; fields are rupee text converted at the edge.
import { paiseToRupeeInput, rupeesToPaise } from "@splittingwisdom/shared";

export interface LineFields {
  /** Rupees, the whole line. */
  price: string;
  /** Whole-number text. */
  quantity: string;
  /** Rupees per unit, only while it's being typed; otherwise it's derived from price and quantity. */
  unit?: string;
}

function toPaise(text: string | undefined): number | null {
  const cleaned = (text ?? "").replace(/[₹,\s]/g, "");
  if (cleaned === "") return null;
  try {
    const paise = rupeesToPaise(cleaned);
    return paise >= 0 ? paise : null;
  } catch {
    return null;
  }
}

function toQuantity(text: string): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= 1 ? n : null;
}

/** The unit cost in paise, or null when the line doesn't divide evenly (₹100 for 3) or can't be read. */
export function exactUnitPaise(price: string, quantity: string): number | null {
  const total = toPaise(price);
  const qty = toQuantity(quantity);
  if (total === null || qty === null || total % qty !== 0) return null;
  return total / qty;
}

/** What the unit cost box shows: what's being typed, else the exact unit cost, else blank. */
export function unitText(line: LineFields): string {
  if (line.unit !== undefined) return line.unit;
  const unit = exactUnitPaise(line.price, line.quantity);
  return unit === null ? "" : paiseToRupeeInput(unit);
}

/** Quantity changed: the unit cost stays put and the total follows. */
export function withQuantity<T extends LineFields>(line: T, quantity: string): T {
  const next = { ...line, quantity, unit: undefined };
  const qty = toQuantity(quantity);
  if (qty === null) return next; // empty or mid-typing: leave the total alone
  const unit = line.unit !== undefined ? toPaise(line.unit) : exactUnitPaise(line.price, line.quantity);
  if (unit !== null) return { ...next, price: paiseToRupeeInput(unit * qty) };
  // An uneven unit cost: keep the same cost per unit by scaling the total, rounded to the paise.
  const total = toPaise(line.price);
  const oldQty = toQuantity(line.quantity);
  if (total === null || oldQty === null) return next;
  return { ...next, price: paiseToRupeeInput(Math.round((total * qty) / oldQty)) };
}

/** Unit cost changed: the total is that cost times the quantity. */
export function withUnit<T extends LineFields>(line: T, unit: string): T {
  const paise = toPaise(unit);
  const qty = toQuantity(line.quantity);
  if (paise === null || qty === null) return { ...line, unit };
  return { ...line, unit, price: paiseToRupeeInput(paise * qty) };
}

/** Total changed by hand: the unit cost is re-derived from it. */
export function withTotal<T extends LineFields>(line: T, price: string): T {
  return { ...line, price, unit: undefined };
}
