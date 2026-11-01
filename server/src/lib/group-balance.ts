import { eq } from "drizzle-orm";
import { db } from "../db.js";
import {
  bills,
  settlements,
  computeBalances,
  getPairwiseBalance,
  type BillForBalance,
  type SettlementForBalance,
  type PairwiseBalance,
} from "@splittingwisdom/shared";

/** A loaded bill (with items and assignments) in the shape the balance engine takes. */
export function toBillForBalance(b: {
  paidByMemberId: number;
  taxAmount: number;
  tipAmount: number;
  serviceFeeAmount: number;
  discountAmount: number;
  items: {
    price: number;
    assignments: {
      memberId: number;
      splitType: "equal" | "percentage" | "ratio" | "custom";
      percentage: number | null;
      ratio: number | null;
      customAmount: number | null;
    }[];
  }[];
}): BillForBalance {
  return {
    paidByMemberId: b.paidByMemberId,
    taxAmount: b.taxAmount,
    tipAmount: b.tipAmount,
    serviceFeeAmount: b.serviceFeeAmount,
    discountAmount: b.discountAmount,
    items: b.items.map((item) => ({
      price: item.price,
      assignments: item.assignments.map((a) => ({
        memberId: a.memberId,
        splitType: a.splitType,
        percentage: a.percentage,
        ratio: a.ratio,
        customAmount: a.customAmount,
      })),
    })),
  };
}

export function toSettlementForBalance(s: {
  payerMemberId: number;
  recipientMemberId: number;
  amount: number;
}): SettlementForBalance {
  return { payerMemberId: s.payerMemberId, recipientMemberId: s.recipientMemberId, amount: s.amount };
}

/** Anything with `.query` — the pool itself or a transaction, so callers can read inside their own transaction. */
type QueryExecutor = Pick<typeof db, "query">;

/** Loads a group's bills/settlements and runs them through the balance engine. */
export async function computeGroupBalances(
  groupId: number,
  executor: QueryExecutor = db,
): Promise<{
  pairwise: PairwiseBalance[];
  lastActivity: Date | null;
}> {
  const [groupBills, groupSettlements] = await Promise.all([
    executor.query.bills.findMany({
      where: eq(bills.groupId, groupId),
      with: { items: { with: { assignments: true } } },
    }),
    executor.query.settlements.findMany({ where: eq(settlements.groupId, groupId) }),
  ]);

  const billsForBalance = groupBills.map(toBillForBalance);
  const settlementsForBalance = groupSettlements.map(toSettlementForBalance);

  const lastActivity = groupBills.reduce<Date | null>((latest, b) => {
    return !latest || b.createdAt > latest ? b.createdAt : latest;
  }, null);

  return { pairwise: computeBalances(billsForBalance, settlementsForBalance), lastActivity };
}

/** A single member's net position within the group: positive = owed to them overall. */
export function memberNetBalance(pairwise: PairwiseBalance[], memberId: number, allMemberIds: number[]): number {
  return allMemberIds.reduce((sum, otherId) => {
    if (otherId === memberId) return sum;
    return sum + getPairwiseBalance(pairwise, otherId, memberId);
  }, 0);
}
