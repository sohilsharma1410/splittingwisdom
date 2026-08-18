import { Router } from "express";
import { eq } from "drizzle-orm";
import {
  groupMembers,
  bills,
  groups,
  splitEqually,
  allocateProportionally,
  billGrandTotal,
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
      const aggregateShares = new Map<number, number>();
      for (const item of bill.items) {
        const shares = splitEqually(
          item.price,
          item.assignments.map((a) => a.memberId),
        );
        for (const [memberId, share] of shares) {
          aggregateShares.set(memberId, (aggregateShares.get(memberId) ?? 0) + share);
        }
      }
      if (aggregateShares.size === 0) continue;

      const taxShares = allocateProportionally(bill.taxAmount, aggregateShares);
      const tipShares = allocateProportionally(bill.tipAmount, aggregateShares);
      const feeShares = allocateProportionally(bill.serviceFeeAmount, aggregateShares);
      const discountShares = allocateProportionally(bill.discountAmount, aggregateShares);

      function totalFor(memberId: number): number {
        if (!aggregateShares.has(memberId)) return 0;
        return (
          (aggregateShares.get(memberId) ?? 0) +
          (taxShares.get(memberId) ?? 0) +
          (tipShares.get(memberId) ?? 0) +
          (feeShares.get(memberId) ?? 0) -
          (discountShares.get(memberId) ?? 0)
        );
      }

      let effect = 0;
      let theirShare = 0;
      const payerIsMe = bill.paidByMemberId === myMemberId;
      const payerIsThem = bill.paidByMemberId === target.counterpartyMemberId;

      if (payerIsMe && aggregateShares.has(target.counterpartyMemberId)) {
        theirShare = totalFor(target.counterpartyMemberId);
        effect = theirShare; // they owe me
      } else if (payerIsThem && aggregateShares.has(myMemberId)) {
        theirShare = totalFor(myMemberId);
        effect = -theirShare; // I owe them
      }

      if (effect === 0) continue;
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
