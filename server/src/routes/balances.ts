import { Router } from "express";
import { eq } from "drizzle-orm";
import {
  groupMembers,
  bills,
  groups,
  settlements,
  countDirectDebts,
  simplifyDebts,
  billGrandTotal,
  computeBillBreakdown,
  computeItemShares,
  type BillItemForBalance,
} from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { computeUserCounterpartyBalances } from "../lib/counterparty-balances.js";
import { computeGroupBalances } from "../lib/group-balance.js";
import { parsePersonId, resolvePersonTargets } from "../lib/person.js";

const router = Router();
router.use(requireAuth);

/** Groups where "simplify debts" would genuinely cut the number of payments. */
async function findSimplifiableGroups(userId: number) {
  const mine = await db.query.groupMembers.findMany({ where: eq(groupMembers.userId, userId) });
  if (mine.length === 0) return [];
  const myGroups = await db.query.groups.findMany({
    where: (g, { inArray }) => inArray(g.id, mine.map((m) => m.groupId)),
    columns: { id: true, name: true, isPersonal: true },
  });
  const perGroup = await Promise.all(
    myGroups
      .filter((g) => !g.isPersonal)
      .map(async (g) => {
        const { pairwise } = await computeGroupBalances(g.id);
        return { groupId: g.id, groupName: g.name, directCount: countDirectDebts(pairwise), simplifiedCount: simplifyDebts(pairwise).length };
      }),
  );
  return perGroup.filter((g) => g.simplifiedCount < g.directCount).sort((a, b) => a.groupId - b.groupId);
}

router.get("/", async (req, res) => {
  const [balances, simplifiableGroups] = await Promise.all([
    computeUserCounterpartyBalances(req.session.userId!),
    findSimplifiableGroups(req.session.userId!),
  ]);

  const totalOwedToMe = balances.filter((b) => b.netAmount > 0).reduce((s, b) => s + b.netAmount, 0);
  const totalIOwe = balances.filter((b) => b.netAmount < 0).reduce((s, b) => s - b.netAmount, 0);

  res.json({
    data: {
      netBalance: totalOwedToMe - totalIOwe,
      totalOwedToMe,
      totalIOwe,
      unsettledCount: balances.filter((b) => b.netAmount !== 0).length,
      simplifiableGroups,
      balances: balances
        .map((b) => ({
          personId: b.key,
          displayName: b.displayName,
          netAmount: b.netAmount,
          lastActivity: b.lastActivity,
        }))
        .sort((a, b) => Math.abs(b.netAmount) - Math.abs(a.netAmount)),
    },
  });
});

router.get("/:personId", async (req, res) => {
  const parsed = parsePersonId(req.params.personId);
  if (!parsed) {
    res.status(404).json({ error: { message: "Person not found." } });
    return;
  }

  const targets = await resolvePersonTargets(req.session.userId!, req.params.personId);

  if (targets.length === 0) {
    res.status(404).json({ error: { message: "Person not found." } });
    return;
  }

  let displayName = "";
  // Bills and payments are tracked apart so the page can show
  // "bills ₹X − settled ₹Y → outstanding ₹Z"; both are signed, positive = they owe me.
  let billsNet = 0;
  let settlementsNet = 0;
  const settlementHistory: {
    id: number;
    groupId: number;
    groupName: string;
    amount: number;
    /** "paid-by-me": I paid them. "paid-to-me": they paid me. */
    direction: "paid-by-me" | "paid-to-me";
    note: string | null;
    settlementDate: Date;
    createdAt: Date;
  }[] = [];
  const contributingBills: {
    billId: number;
    description: string;
    groupName: string;
    billDate: string;
    payerIsMe: boolean;
    payerName: string;
    grandTotal: number;
    theirShare: number;
    items: { itemId: number; name: string; price: number; splitType: string; share: number }[];
  }[] = [];

  for (const target of targets) {
    const myMemberId = target.myMemberId;

    const [group, groupBills, counterpartyMember, myMember] = await Promise.all([
      db.query.groups.findFirst({ where: eq(groups.id, target.groupId) }),
      db.query.bills.findMany({
        where: eq(bills.groupId, target.groupId),
        with: { items: { with: { assignments: true } }, paidBy: true },
      }),
      db.query.groupMembers.findFirst({
        where: eq(groupMembers.id, target.counterpartyMemberId),
        with: { user: { columns: { displayName: true } } },
      }),
      db.query.groupMembers.findFirst({ where: eq(groupMembers.id, myMemberId) }),
    ]);
    if (!group || !counterpartyMember || !myMember) continue;

    displayName = counterpartyMember.user?.displayName ?? counterpartyMember.displayName;

    for (const bill of groupBills) {
      const balanceItems: BillItemForBalance[] = bill.items.map((item) => ({
        price: item.price,
        assignments: item.assignments.map((a) => ({
          memberId: a.memberId,
          splitType: a.splitType,
          percentage: a.percentage,
          ratio: a.ratio,
          customAmount: a.customAmount,
        })),
      }));
      const breakdown = computeBillBreakdown({
        paidByMemberId: bill.paidByMemberId,
        taxAmount: bill.taxAmount,
        tipAmount: bill.tipAmount,
        serviceFeeAmount: bill.serviceFeeAmount,
        discountAmount: bill.discountAmount,
        items: balanceItems,
      });
      if (breakdown.length === 0) continue;

      const payerIsMe = bill.paidByMemberId === myMemberId;
      const payerIsThem = bill.paidByMemberId === target.counterpartyMemberId;

      let effect = 0;
      let theirShare = 0;
      // The relevant person for the item-level "what's driving this" list:
      // the counterparty when I paid (they owe me), or me when they paid.
      let relevantMemberId: number | null = null;

      if (payerIsMe) {
        const row = breakdown.find((r) => r.memberId === target.counterpartyMemberId);
        if (row) {
          theirShare = row.total;
          effect = theirShare; // they owe me
          relevantMemberId = target.counterpartyMemberId;
        }
      } else if (payerIsThem) {
        const row = breakdown.find((r) => r.memberId === myMemberId);
        if (row) {
          theirShare = row.total;
          effect = -theirShare; // I owe them
          relevantMemberId = myMemberId;
        }
      }

      if (effect === 0 || relevantMemberId === null) continue;

      const items = bill.items.flatMap((item) => {
        const assignment = item.assignments.find((a) => a.memberId === relevantMemberId);
        if (!assignment) return [];
        const shares = computeItemShares({
          price: item.price,
          assignments: item.assignments.map((a) => ({
            memberId: a.memberId,
            splitType: a.splitType,
            percentage: a.percentage,
            ratio: a.ratio,
            customAmount: a.customAmount,
          })),
        });
        return [
          {
            itemId: item.id,
            name: item.name,
            price: item.price,
            splitType: assignment.splitType,
            share: shares.get(relevantMemberId!) ?? 0,
          },
        ];
      });

      billsNet += effect;
      contributingBills.push({
        billId: bill.id,
        description: bill.description,
        groupName: group.name,
        billDate: bill.billDate,
        payerIsMe,
        payerName: bill.paidBy.displayName,
        grandTotal: billGrandTotal(bill),
        theirShare,
        items,
      });
    }

    const groupSettlements = await db.query.settlements.findMany({ where: eq(settlements.groupId, target.groupId) });
    for (const payment of groupSettlements) {
      const iPaid = payment.payerMemberId === myMemberId && payment.recipientMemberId === target.counterpartyMemberId;
      const theyPaid = payment.payerMemberId === target.counterpartyMemberId && payment.recipientMemberId === myMemberId;
      if (!iPaid && !theyPaid) continue;
      settlementsNet += iPaid ? payment.amount : -payment.amount;
      settlementHistory.push({
        id: payment.id,
        groupId: target.groupId,
        groupName: group.name,
        amount: payment.amount,
        direction: iPaid ? "paid-by-me" : "paid-to-me",
        note: payment.note,
        settlementDate: payment.settlementDate,
        createdAt: payment.createdAt,
      });
    }
  }

  contributingBills.sort((a, b) => (a.billDate < b.billDate ? 1 : -1));
  settlementHistory.sort((a, b) => b.settlementDate.getTime() - a.settlementDate.getTime() || b.id - a.id);

  res.json({
    data: {
      personId: req.params.personId,
      displayName,
      netAmount: billsNet + settlementsNet,
      billsNet,
      settlementsNet,
      contributingBills,
      settlements: settlementHistory,
    },
  });
});

export default router;
