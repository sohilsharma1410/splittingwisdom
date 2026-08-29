/**
 * Phase 2 migration verification — NOT a data migration (none is needed:
 * every Phase 1 bill already has a real bill_items row and item_assignments
 * rows with split_type='equal', per IMPLEMENTATION-NOTES.md item 1). This
 * script proves that claim against the live database: for every existing
 * bill, it computes each member's total two ways —
 *
 *   1. "old": replicates exactly what server/src/routes/bills.ts did before
 *      the Phase 2 engine change — splitEqually(bill.subtotalAmount,
 *      memberIds) off the bill's single item, ignoring per-item data.
 *   2. "new": the Phase 2 shared engine (computeBillBreakdown), reading the
 *      bill's real items/assignments from the database.
 *
 * and asserts they're byte-identical in paise for every member on every
 * bill. A bill with more than one item, or any non-"equal" split, is new
 * Phase 2 data (couldn't have existed before this change) and is reported
 * separately rather than compared — there's no "old" value to check it
 * against.
 *
 * Run from server/: npx tsx scripts/verify-phase2-balances.ts
 */
import "dotenv/config";
import { db } from "../src/db.js";
import { splitEqually, allocateProportionally, computeBillBreakdown, type BillItemForBalance } from "@splittingwisdom/shared";

async function main() {
  const bills = await db.query.bills.findMany({
    with: { items: { with: { assignments: true } } },
  });

  console.log(`Checking ${bills.length} bill(s)...\n`);

  let checked = 0;
  let newShapeCount = 0;
  const mismatches: string[] = [];

  for (const bill of bills) {
    const isOldShape = bill.items.length === 1 && bill.items[0].assignments.every((a) => a.splitType === "equal");

    if (!isOldShape) {
      newShapeCount++;
      continue;
    }

    const item = bill.items[0];
    const memberIds = item.assignments.map((a) => a.memberId);

    // --- old logic (pre-Phase-2 bills.ts computeShareBreakdown) ---
    const oldItemShares = splitEqually(bill.subtotalAmount, memberIds);
    const oldTaxShares = allocateProportionally(bill.taxAmount, oldItemShares);
    const oldTipShares = allocateProportionally(bill.tipAmount, oldItemShares);
    const oldFeeShares = allocateProportionally(bill.serviceFeeAmount, oldItemShares);
    const oldDiscountShares = allocateProportionally(bill.discountAmount, oldItemShares);
    const oldTotals = new Map(
      memberIds.map((id) => [
        id,
        (oldItemShares.get(id) ?? 0) +
          (oldTaxShares.get(id) ?? 0) +
          (oldTipShares.get(id) ?? 0) +
          (oldFeeShares.get(id) ?? 0) -
          (oldDiscountShares.get(id) ?? 0),
      ]),
    );

    // --- new logic (Phase 2 shared engine) ---
    const balanceItems: BillItemForBalance[] = bill.items.map((i) => ({
      price: i.price,
      assignments: i.assignments.map((a) => ({
        memberId: a.memberId,
        splitType: a.splitType,
        percentage: a.percentage,
        ratio: a.ratio,
        customAmount: a.customAmount,
      })),
    }));
    const newBreakdown = computeBillBreakdown({
      paidByMemberId: bill.paidByMemberId,
      taxAmount: bill.taxAmount,
      tipAmount: bill.tipAmount,
      serviceFeeAmount: bill.serviceFeeAmount,
      discountAmount: bill.discountAmount,
      items: balanceItems,
    });
    const newTotals = new Map(newBreakdown.map((row) => [row.memberId, row.total]));

    checked++;
    for (const memberId of memberIds) {
      const oldTotal = oldTotals.get(memberId) ?? 0;
      const newTotal = newTotals.get(memberId) ?? 0;
      if (oldTotal !== newTotal) {
        mismatches.push(
          `Bill ${bill.id} ("${bill.description}") member ${memberId}: old=${oldTotal} new=${newTotal}`,
        );
      }
    }
  }

  console.log(`Old-shape bills checked: ${checked}`);
  console.log(`New-shape (Phase 2) bills skipped from comparison: ${newShapeCount}`);
  console.log();

  if (mismatches.length === 0) {
    console.log("PASS — every existing balance is identical under the new engine.");
    process.exit(0);
  } else {
    console.error(`FAIL — ${mismatches.length} mismatch(es):`);
    for (const m of mismatches) console.error(`  ${m}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
