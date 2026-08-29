/**
 * Money helpers. All amounts are integer paise (INR minor units) everywhere
 * except at display/input edges. Never do arithmetic on rupee floats.
 */

const RUPEE_FORMATTER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const RUPEE_INPUT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export function formatPaise(paise: number): string {
  return RUPEE_FORMATTER.format(paise / 100);
}

/** subtotal + tax + tip + serviceFee − discount. Always derived, never stored. */
export function billGrandTotal(bill: {
  subtotalAmount: number;
  taxAmount: number;
  tipAmount: number;
  serviceFeeAmount: number;
  discountAmount: number;
}): number {
  return (
    bill.subtotalAmount + bill.taxAmount + bill.tipAmount + bill.serviceFeeAmount - bill.discountAmount
  );
}

/** Parses a rupee-denominated input string (e.g. "1234.5", "1234") into integer paise. */
export function rupeesToPaise(input: string): number {
  const trimmed = input.trim();
  if (!RUPEE_INPUT_PATTERN.test(trimmed)) {
    throw new Error(`Invalid rupee amount: "${input}"`);
  }
  const [wholePart, fractionPart = ""] = trimmed.split(".");
  const paddedFraction = (fractionPart + "00").slice(0, 2);
  const sign = wholePart.startsWith("-") ? -1 : 1;
  const wholeDigits = wholePart.replace("-", "");
  return sign * (Number(wholeDigits) * 100 + Number(paddedFraction));
}

export function paiseToRupeeInput(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const fraction = (abs % 100).toString().padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}

/**
 * Splits totalPaise equally among memberIds using floor(P/N) each, then
 * distributes the remainder paise one each to members in ascending member-id
 * order (CLAUDE.md money rule #3). Deterministic and exact: the returned
 * shares always sum to exactly totalPaise.
 */
export function splitEqually(
  totalPaise: number,
  memberIds: number[],
): Map<number, number> {
  if (memberIds.length === 0) {
    throw new Error("Cannot split among zero members");
  }
  const sortedIds = [...memberIds].sort((a, b) => a - b);
  const n = sortedIds.length;
  const base = Math.floor(totalPaise / n);
  const remainder = totalPaise - base * n;

  const shares = new Map<number, number>();
  sortedIds.forEach((id, index) => {
    shares.set(id, base + (index < remainder ? 1 : 0));
  });
  return shares;
}

/**
 * Allocates totalPaise proportionally across weighted shares (e.g. tax/tip
 * allocation by pre-tax subtotal), floor + deterministic remainder by
 * ascending member id (same rule as splitEqually). Members with zero weight
 * receive zero.
 */
export function allocateProportionally(
  totalPaise: number,
  weights: Map<number, number>,
): Map<number, number> {
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);
  const sortedIds = [...weights.keys()].sort((a, b) => a - b);

  if (totalWeight === 0 || totalPaise === 0) {
    return new Map(sortedIds.map((id) => [id, 0]));
  }

  const base = new Map<number, number>();
  let allocated = 0;
  for (const id of sortedIds) {
    const weight = weights.get(id) ?? 0;
    const share = Math.floor((totalPaise * weight) / totalWeight);
    base.set(id, share);
    allocated += share;
  }

  let remainder = totalPaise - allocated;
  for (const id of sortedIds) {
    if (remainder <= 0) break;
    const weight = weights.get(id) ?? 0;
    if (weight === 0) continue;
    base.set(id, (base.get(id) ?? 0) + 1);
    remainder -= 1;
  }
  return base;
}

/**
 * How far a set of percentage-split inputs is from summing to 100. Zero
 * means valid; a positive result is the gap still needed, negative means
 * they've gone over. Used for live "gap to 100" validation in the
 * assignment editor and re-checked server-side before saving.
 */
export function percentageGap(percentages: number[]): number {
  const sum = percentages.reduce((a, b) => a + b, 0);
  return 100 - sum;
}

/**
 * How far a set of custom-amount inputs (paise) is from summing to the
 * item's price. Zero means valid; a positive result is the amount still
 * remaining to allocate, negative means they've gone over.
 */
export function customAmountRemaining(customAmountsPaise: number[], itemPricePaise: number): number {
  const sum = customAmountsPaise.reduce((a, b) => a + b, 0);
  return itemPricePaise - sum;
}

/** Ratio split parts must be positive integers (e.g. 2:1:1). */
export function isValidRatioPart(ratio: number): boolean {
  return Number.isInteger(ratio) && ratio > 0;
}
