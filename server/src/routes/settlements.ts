import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import {
  allocateAcrossGroups,
  checkSettlement,
  createSettlementSchema,
  directDebt,
  formatPaise,
  getPairwiseBalance,
  groupMembers,
  routeThroughDebts,
  settlements,
  type GroupDebtLine,
} from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { idempotency } from "../middleware/idempotency.js";
import { getMembership } from "../middleware/authorize.js";
import { computeGroupBalances } from "../lib/group-balance.js";
import { resolvePersonTargets } from "../lib/person.js";

const router = Router();
router.use(requireAuth);

// Advisory-lock namespace for "recording a payment in group N". Two payments
// in the same group are serialised so both can't pass the cap check against
// the same outstanding balance and together overpay it.
const SETTLEMENT_LOCK_NAMESPACE = 7001;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Rejection = { rejected: { status: number; message: string } };

async function lockGroups(tx: Tx, groupIds: number[]) {
  // Always ascending so two requests spanning the same groups can't deadlock.
  for (const groupId of [...new Set(groupIds)].sort((a, b) => a - b)) {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETTLEMENT_LOCK_NAMESPACE}, ${groupId})`);
  }
}

function settlementTimestamp(date: string | undefined): Date {
  // A date picker gives a day, not a moment: pin it to midday UTC so it
  // reads as the same calendar day in every timezone we care about.
  return date ? new Date(`${date}T12:00:00Z`) : new Date();
}

const reject = (status: number, message: string): Rejection => ({ rejected: { status, message } });

// ---------------------------------------------------------------------------
// POST /api/settlements — record a payment (full or partial)
// ---------------------------------------------------------------------------
router.post("/", idempotency(), async (req, res) => {
  const parsed = createSettlementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }
  const input = parsed.data;
  const userId = req.session.userId!;
  const note = input.note ? input.note : null;
  const settlementDate = settlementTimestamp(input.settlementDate);

  if (input.mode === "pair") {
    const membership = await getMembership(userId, input.groupId);
    if (!membership) {
      res.status(404).json({ error: { message: "Group not found." } });
      return;
    }
    if (membership.id !== input.payerMemberId && membership.id !== input.recipientMemberId) {
      res.status(403).json({ error: { message: "You can only record payments you're part of." } });
      return;
    }
    const members = await db.query.groupMembers.findMany({ where: eq(groupMembers.groupId, input.groupId) });
    const memberIds = new Set(members.map((m) => m.id));
    if (!memberIds.has(input.payerMemberId) || !memberIds.has(input.recipientMemberId)) {
      res.status(400).json({ error: { message: "Both people must be in this group." } });
      return;
    }

    const outcome = await db.transaction(async (tx): Promise<Rejection | { created: (typeof settlements.$inferSelect)[] }> => {
      await lockGroups(tx, [input.groupId]);
      const { pairwise } = await computeGroupBalances(input.groupId, tx);
      const check = checkSettlement(pairwise, input.payerMemberId, input.recipientMemberId, input.amount);
      if (!check.ok) return reject(422, check.message);

      // A real debt between these two is paid directly. Otherwise (a "simplified" payment, where
      // the payer owes someone else) it is recorded as the chain of real debts it stands for, so
      // the Direct view ends up clean instead of leaving offsetting entries behind.
      const hops =
        input.amount <= directDebt(pairwise, input.payerMemberId, input.recipientMemberId)
          ? null
          : routeThroughDebts(pairwise, input.payerMemberId, input.recipientMemberId, input.amount);
      const nameOf = (id: number) => members.find((m) => m.id === id)?.displayName ?? "someone";
      const rows = hops
        ? hops.map((h) => ({
            groupId: input.groupId,
            payerMemberId: h.fromMemberId,
            recipientMemberId: h.toMemberId,
            amount: h.amount,
            note: `Simplified payment: ${nameOf(input.payerMemberId)} paid ${nameOf(input.recipientMemberId)}${note ? ` — ${note}` : ""}`.slice(0, 200),
            settlementDate,
          }))
        : [{ groupId: input.groupId, payerMemberId: input.payerMemberId, recipientMemberId: input.recipientMemberId, amount: input.amount, note, settlementDate }];
      const created = await tx.insert(settlements).values(rows).returning();
      return { created };
    });

    if ("rejected" in outcome) {
      res.status(outcome.rejected.status).json({ error: { message: outcome.rejected.message } });
      return;
    }
    res.status(201).json({ data: { settlements: outcome.created, totalAmount: input.amount } });
    return;
  }

  // mode === "person": split the payment across the groups where the debt is.
  const targets = await resolvePersonTargets(userId, input.personId);
  if (targets.length === 0) {
    res.status(404).json({ error: { message: "Person not found." } });
    return;
  }

  const outcome = await db.transaction(async (tx): Promise<Rejection | { created: (typeof settlements.$inferSelect)[] }> => {
    await lockGroups(tx, targets.map((t) => t.groupId));

    const perGroup = await Promise.all(
      targets.map(async (t) => ({ target: t, pairwise: (await computeGroupBalances(t.groupId, tx)).pairwise })),
    );
    // Positive: they owe me overall. The sign decides who is the payer.
    const net = perGroup.reduce((sum, g) => sum + getPairwiseBalance(g.pairwise, g.target.counterpartyMemberId, g.target.myMemberId), 0);
    if (net === 0) return reject(422, "Nothing is owed between you two.");
    if (input.amount > Math.abs(net)) {
      return reject(422, `That's more than is owed. The most you can settle is ${formatPaise(Math.abs(net))}.`);
    }

    const iPay = net < 0;
    const lines: GroupDebtLine[] = perGroup.map(({ target, pairwise }) => ({
      groupId: target.groupId,
      payerMemberId: iPay ? target.myMemberId : target.counterpartyMemberId,
      recipientMemberId: iPay ? target.counterpartyMemberId : target.myMemberId,
      owed: iPay
        ? directDebt(pairwise, target.myMemberId, target.counterpartyMemberId)
        : directDebt(pairwise, target.counterpartyMemberId, target.myMemberId),
    }));
    const { allocations, remainder } = allocateAcrossGroups(lines, input.amount);
    if (remainder !== 0 || allocations.length === 0) return reject(422, "That payment doesn't match what is owed.");

    const created = await tx
      .insert(settlements)
      .values(allocations.map((a) => ({ ...a, note, settlementDate })))
      .returning();
    return { created };
  });

  if ("rejected" in outcome) {
    res.status(outcome.rejected.status).json({ error: { message: outcome.rejected.message } });
    return;
  }
  res.status(201).json({ data: { settlements: outcome.created, totalAmount: input.amount } });
});

// ---------------------------------------------------------------------------
// GET /api/settlements?groupId=N — a group's payment history, newest first
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const groupId = Number(req.query.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0) {
    res.status(400).json({ error: { message: "Choose a group." } });
    return;
  }
  const membership = await getMembership(req.session.userId!, groupId);
  if (!membership) {
    res.status(404).json({ error: { message: "Group not found." } });
    return;
  }

  const rows = await db.query.settlements.findMany({
    where: eq(settlements.groupId, groupId),
    with: { payer: true, recipient: true },
    orderBy: (s, { desc }) => [desc(s.settlementDate), desc(s.id)],
  });

  res.json({
    data: {
      settlements: rows.map((s) => ({
        id: s.id,
        groupId: s.groupId,
        payerMemberId: s.payerMemberId,
        payerName: s.payer.displayName,
        recipientMemberId: s.recipientMemberId,
        recipientName: s.recipient.displayName,
        amount: s.amount,
        note: s.note,
        settlementDate: s.settlementDate,
        createdAt: s.createdAt,
      })),
    },
  });
});

export default router;
