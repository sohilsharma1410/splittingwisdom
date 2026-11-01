import { inArray } from "drizzle-orm";
import { db } from "../db.js";
import { bills, settlements, computeBillSettlementStatuses, type BillSettlementStatus } from "@splittingwisdom/shared";
import { toBillForBalance, toSettlementForBalance } from "./group-balance.js";

/**
 * Settled/Pending for every bill in the given groups, derived from the
 * bills and settlements themselves (never the stored `bills.status` column,
 * which nothing updates). Payments are applied to the oldest bills first.
 */
export async function loadBillStatuses(groupIds: number[]): Promise<Map<number, BillSettlementStatus>> {
  const result = new Map<number, BillSettlementStatus>();
  if (groupIds.length === 0) return result;

  const [groupBills, groupSettlements] = await Promise.all([
    db.query.bills.findMany({
      where: inArray(bills.groupId, groupIds),
      with: { items: { with: { assignments: true } } },
    }),
    db.query.settlements.findMany({ where: inArray(settlements.groupId, groupIds) }),
  ]);

  for (const groupId of new Set(groupIds)) {
    const statuses = computeBillSettlementStatuses(
      groupBills
        .filter((b) => b.groupId === groupId)
        .map((b) => ({ ...toBillForBalance(b), id: b.id, sortKey: Date.parse(`${b.billDate}T00:00:00Z`) })),
      groupSettlements.filter((s) => s.groupId === groupId).map(toSettlementForBalance),
    );
    for (const [billId, status] of statuses) result.set(billId, status);
  }
  return result;
}
