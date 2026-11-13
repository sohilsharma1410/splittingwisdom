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
  computeBillDebts,
  type BillItemForBalance,
} from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { computeUserCounterpartyBalances } from "../lib/counterparty-balances.js";
import { computeGroupBalances, computeMemberSummary } from "../lib/group-balance.js";
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

/** The user's share and what they paid, summed over every group they're in. */
async function sumMySpending(userId: number) {
  const mine = await db.query.groupMembers.findMany({ where: eq(groupMembers.userId, userId) });
  const summaries = await Promise.all(mine.map((m) => computeMemberSummary(m.groupId, m.id)));
  return {
    myShare: summaries.reduce((sum, s) => sum + s.share, 0),
    iPaid: summaries.reduce((sum, s) => sum + s.paid, 0),
  };
}

router.get("/", async (req, res) => {
  const [balances, simplifiableGroups, spending] = await Promise.all([
    computeUserCounterpartyBalances(req.session.userId!),
    findSimplifiableGroups(req.session.userId!),
    sumMySpending(req.session.userId!),
  ]);

  const totalOwedToMe = balances.filter((b) => b.netAmount > 0).reduce((s, b) => s + b.netAmount, 0);
  const totalIOwe = balances.filter((b) => b.netAmount < 0).reduce((s, b) => s - b.netAmount, 0);

  res.json({
    data: {
      netBalance: totalOwedToMe - totalIOwe,
      totalOwedToMe,
      totalIOwe,
      ...spending,
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
    payerNames: string[] | null;
    grandTotal: number;
    theirShare: number;
    owed: number;
    items: { itemId: number; name: string; price: number; splitType: string; share: number }[];
  }[] = [];

  for (const target of targets) {
    const myMemberId = target.myMemberId;

    const [group, groupBills, counterpartyMember, myMember, allMembers] = await Promise.all([
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
      db.query.groupMembers.findMany({ where: eq(groupMembers.groupId, target.groupId), columns: { id: true, displayName: true } }),
    ]);
    const groupMemberNames = new Map(allMembers.map((m) => [m.id, m.displayName]));
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
      const forBalance = {
        paidByMemberId: bill.paidByMemberId,
        payers: bill.payers,
        taxAmount: bill.taxAmount,
        tipAmount: bill.tipAmount,
        serviceFeeAmount: bill.serviceFeeAmount,
        discountAmount: bill.discountAmount,
        items: balanceItems,
      };
      const breakdown = computeBillBreakdown(forBalance);
      if (breakdown.length === 0) continue;

      // What this bill makes the two of us owe each other, from the same engine as the balances.
      // Positive: they owe me. With one payer this is just the other person's share.
      const effect = computeBillDebts(forBalance).reduce((sum, d) => {
        if (d.debtorId === target.counterpartyMemberId && d.creditorId === myMemberId) return sum + d.amount;
        if (d.debtorId === myMemberId && d.creditorId === target.counterpartyMemberId) return sum - d.amount;
        return sum;
      }, 0);
      if (effect === 0) continue;

      const payerIsMe = effect > 0;
      // The item list shows what the person who owes had on this bill.
      const relevantMemberId = payerIsMe ? target.counterpartyMemberId : myMemberId;
      const theirShare = breakdown.find((r) => r.memberId === relevantMemberId)?.total ?? 0;
      const payerNames = (bill.payers ?? []).map((p) => (p.memberId === myMemberId ? "You" : groupMemberNames.get(p.memberId) ?? "Someone"));

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
        payerNames: payerNames.length > 0 ? payerNames : null,
        grandTotal: billGrandTotal(bill),
        theirShare,
        owed: Math.abs(effect),
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
