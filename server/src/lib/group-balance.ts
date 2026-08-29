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

/** Loads a group's bills/settlements and runs them through the balance engine. */
export async function computeGroupBalances(groupId: number): Promise<{
  pairwise: PairwiseBalance[];
  lastActivity: Date | null;
}> {
  const [groupBills, groupSettlements] = await Promise.all([
    db.query.bills.findMany({
      where: eq(bills.groupId, groupId),
      with: { items: { with: { assignments: true } } },
    }),
    db.query.settlements.findMany({ where: eq(settlements.groupId, groupId) }),
  ]);

  const billsForBalance: BillForBalance[] = groupBills.map((b) => ({
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
  }));
  const settlementsForBalance: SettlementForBalance[] = groupSettlements.map((s) => ({
    payerMemberId: s.payerMemberId,
    recipientMemberId: s.recipientMemberId,
    amount: s.amount,
  }));

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
