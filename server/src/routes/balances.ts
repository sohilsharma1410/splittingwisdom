import { Router } from "express";
import { eq } from "drizzle-orm";
import {
  groupMembers,
  bills,
  groups,
  billGrandTotal,
  computeBillBreakdown,
  computeItemShares,
  type BillItemForBalance,
} from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { computeUserCounterpartyBalances } from "../lib/counterparty-balances.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const balances = await computeUserCounterpartyBalances(req.session.userId!);

  const totalOwedToMe = balances.filter((b) => b.netAmount > 0).reduce((s, b) => s + b.netAmount, 0);
  const totalIOwe = balances.filter((b) => b.netAmount < 0).reduce((s, b) => s - b.netAmount, 0);

  res.json({
    data: {
      netBalance: totalOwedToMe - totalIOwe,
      totalOwedToMe,
      totalIOwe,
      unsettledCount: balances.filter((b) => b.netAmount !== 0).length,
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

function parsePersonId(personId: string): { type: "user" | "member"; id: number } | null {
  const match = /^([um])-(\d+)$/.exec(personId);
  if (!match) return null;
  return { type: match[1] === "u" ? "user" : "member", id: Number(match[2]) };
}

router.get("/:personId", async (req, res) => {
  const parsed = parsePersonId(req.params.personId);
  if (!parsed) {
    res.status(404).json({ error: { message: "Person not found." } });
    return;
  }

  const myMemberships = await db.query.groupMembers.findMany({
    where: eq(groupMembers.userId, req.session.userId!),
  });
  const myMembershipByGroup = new Map(myMemberships.map((m) => [m.groupId, m]));

  // Find every (groupId, counterpartyMemberId) pair this personId resolves to,
  // restricted to groups the current user is actually a member of.
  const targets: { groupId: number; counterpartyMemberId: number }[] = [];
  if (parsed.type === "user") {
    const rows = await db.query.groupMembers.findMany({ where: eq(groupMembers.userId, parsed.id) });
    for (const row of rows) {
      if (myMembershipByGroup.has(row.groupId)) {
        targets.push({ groupId: row.groupId, counterpartyMemberId: row.id });
      }
    }
  } else {
    const row = await db.query.groupMembers.findFirst({ where: eq(groupMembers.id, parsed.id) });
    if (row && myMembershipByGroup.has(row.groupId)) {
      targets.push({ groupId: row.groupId, counterpartyMemberId: row.id });
    }
  }

  if (targets.length === 0) {
    res.status(404).json({ error: { message: "Person not found." } });
    return;
  }

  let displayName = "";
  let netAmount = 0;
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
    const myMemberId = myMembershipByGroup.get(target.groupId)!.id;

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

      netAmount += effect;
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
  }

  contributingBills.sort((a, b) => (a.billDate < b.billDate ? 1 : -1));

  res.json({
    data: {
      personId: req.params.personId,
      displayName,
      netAmount,
      contributingBills,
    },
  });
});

export default router;
