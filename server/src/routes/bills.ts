import { Router } from "express";
import { eq } from "drizzle-orm";
import {
  createBillSchema,
  updateBillSchema,
  bills,
  billItems,
  itemAssignments,
  groupMembers,
  users,
  splitEqually,
  allocateProportionally,
} from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getMembership } from "../middleware/authorize.js";

const router = Router();
router.use(requireAuth);

async function loadGroupMemberIds(groupId: number): Promise<Set<number>> {
  const members = await db.query.groupMembers.findMany({
    where: eq(groupMembers.groupId, groupId),
    columns: { id: true },
  });
  return new Set(members.map((m) => m.id));
}

/** Builds the per-member "how was this calculated" breakdown for a bill. */
function computeShareBreakdown(bill: {
  subtotalAmount: number;
  taxAmount: number;
  tipAmount: number;
  serviceFeeAmount: number;
  discountAmount: number;
}, memberIds: number[]) {
  const itemShares = splitEqually(bill.subtotalAmount, memberIds);
  const taxShares = allocateProportionally(bill.taxAmount, itemShares);
  const tipShares = allocateProportionally(bill.tipAmount, itemShares);
  const feeShares = allocateProportionally(bill.serviceFeeAmount, itemShares);
  const discountShares = allocateProportionally(bill.discountAmount, itemShares);

  return memberIds.map((id) => ({
    memberId: id,
    itemShare: itemShares.get(id)!,
    taxShare: taxShares.get(id)!,
    tipShare: tipShares.get(id)!,
    serviceFeeShare: feeShares.get(id)!,
    discountShare: discountShares.get(id)!,
    total:
      itemShares.get(id)! +
      taxShares.get(id)! +
      tipShares.get(id)! +
      feeShares.get(id)! -
      discountShares.get(id)!,
  }));
}

router.post("/", async (req, res) => {
  const parsed = createBillSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }
  const input = parsed.data;

  const membership = await getMembership(req.session.userId!, input.groupId);
  if (!membership) {
    res.status(404).json({ error: { message: "Group not found." } });
    return;
  }

  const validMemberIds = await loadGroupMemberIds(input.groupId);
  const invalidSplit = input.splitMemberIds.filter((id) => !validMemberIds.has(id));
  if (invalidSplit.length > 0 || !validMemberIds.has(input.paidByMemberId)) {
    res.status(400).json({ error: { message: "Selected members must belong to this group." } });
    return;
  }

  const uniqueSplitIds = [...new Set(input.splitMemberIds)];

  const bill = await db.transaction(async (tx) => {
    const [newBill] = await tx
      .insert(bills)
      .values({
        groupId: input.groupId,
        description: input.description,
        merchant: input.merchant ?? null,
        billDate: input.billDate,
        subtotalAmount: input.subtotalAmount,
        taxAmount: input.taxAmount ?? 0,
        tipAmount: input.tipAmount ?? 0,
        serviceFeeAmount: input.serviceFeeAmount ?? 0,
        discountAmount: input.discountAmount ?? 0,
        paidByMemberId: input.paidByMemberId,
        createdByUserId: req.session.userId!,
      })
      .returning();

    const [item] = await tx
      .insert(billItems)
      .values({ billId: newBill.id, name: "Entire bill", price: input.subtotalAmount, sortOrder: 0 })
      .returning();

    await tx.insert(itemAssignments).values(
      uniqueSplitIds.map((memberId) => ({
        billItemId: item.id,
        memberId,
        splitType: "equal" as const,
      })),
    );

    return newBill;
  });

  res.status(201).json({ data: { bill } });
});

router.get("/:id", async (req, res) => {
  const billId = Number(req.params.id);
  if (!Number.isInteger(billId)) {
    res.status(404).json({ error: { message: "Bill not found." } });
    return;
  }

  const bill = await db.query.bills.findFirst({
    where: eq(bills.id, billId),
    with: {
      group: true,
      paidBy: true,
      items: { with: { assignments: { with: { member: true } } } },
    },
  });
  if (!bill) {
    res.status(404).json({ error: { message: "Bill not found." } });
    return;
  }

  const membership = await getMembership(req.session.userId!, bill.groupId);
  if (!membership) {
    res.status(404).json({ error: { message: "Bill not found." } });
    return;
  }

  const [createdBy, lastEditedBy] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, bill.createdByUserId), columns: { displayName: true } }),
    bill.lastEditedByUserId
      ? db.query.users.findFirst({ where: eq(users.id, bill.lastEditedByUserId), columns: { displayName: true } })
      : Promise.resolve(null),
  ]);

  const item = bill.items[0];
  const memberIds = item?.assignments.map((a) => a.memberId) ?? [];
  const breakdown = memberIds.length > 0 ? computeShareBreakdown(bill, memberIds) : [];
  const memberNames = new Map(
    (item?.assignments ?? []).map((a) => [a.memberId, a.member.displayName]),
  );

  res.json({
    data: {
      bill: {
        id: bill.id,
        groupId: bill.groupId,
        groupName: bill.group.name,
        description: bill.description,
        merchant: bill.merchant,
        billDate: bill.billDate,
        subtotalAmount: bill.subtotalAmount,
        taxAmount: bill.taxAmount,
        tipAmount: bill.tipAmount,
        serviceFeeAmount: bill.serviceFeeAmount,
        discountAmount: bill.discountAmount,
        grandTotal:
          bill.subtotalAmount + bill.taxAmount + bill.tipAmount + bill.serviceFeeAmount - bill.discountAmount,
        paidByMemberId: bill.paidByMemberId,
        paidByName: bill.paidBy.displayName,
        status: bill.status,
        createdByName: createdBy?.displayName ?? "Someone",
        lastEditedByName: lastEditedBy?.displayName ?? null,
        lastEditedAt: bill.lastEditedAt,
        createdAt: bill.createdAt,
        updatedAt: bill.updatedAt,
        splitMemberIds: memberIds,
        breakdown: breakdown.map((b) => ({ ...b, displayName: memberNames.get(b.memberId) })),
      },
    },
  });
});

router.patch("/:id", async (req, res) => {
  const billId = Number(req.params.id);
  if (!Number.isInteger(billId)) {
    res.status(404).json({ error: { message: "Bill not found." } });
    return;
  }

  const existing = await db.query.bills.findFirst({ where: eq(bills.id, billId) });
  if (!existing) {
    res.status(404).json({ error: { message: "Bill not found." } });
    return;
  }
  const membership = await getMembership(req.session.userId!, existing.groupId);
  if (!membership) {
    res.status(404).json({ error: { message: "Bill not found." } });
    return;
  }

  const parsed = updateBillSchema.safeParse({ ...req.body, groupId: existing.groupId });
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }
  const input = parsed.data;

  const validMemberIds = await loadGroupMemberIds(existing.groupId);
  if (input.paidByMemberId && !validMemberIds.has(input.paidByMemberId)) {
    res.status(400).json({ error: { message: "Payer must belong to this group." } });
    return;
  }
  const splitMemberIds = input.splitMemberIds ? [...new Set(input.splitMemberIds)] : undefined;
  if (splitMemberIds?.some((id) => !validMemberIds.has(id))) {
    res.status(400).json({ error: { message: "Selected members must belong to this group." } });
    return;
  }

  const updated = await db.transaction(async (tx) => {
    const [bill] = await tx
      .update(bills)
      .set({
        ...(input.description !== undefined && { description: input.description }),
        ...(input.merchant !== undefined && { merchant: input.merchant }),
        ...(input.billDate !== undefined && { billDate: input.billDate }),
        ...(input.subtotalAmount !== undefined && { subtotalAmount: input.subtotalAmount }),
        ...(input.taxAmount !== undefined && { taxAmount: input.taxAmount }),
        ...(input.tipAmount !== undefined && { tipAmount: input.tipAmount }),
        ...(input.serviceFeeAmount !== undefined && { serviceFeeAmount: input.serviceFeeAmount }),
        ...(input.discountAmount !== undefined && { discountAmount: input.discountAmount }),
        ...(input.paidByMemberId !== undefined && { paidByMemberId: input.paidByMemberId }),
        lastEditedByUserId: req.session.userId!,
        lastEditedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bills.id, billId))
      .returning();

    if (splitMemberIds) {
      const items = await tx.query.billItems.findMany({ where: eq(billItems.billId, billId) });
      const itemId = items[0]?.id;
      if (itemId) {
        if (input.subtotalAmount !== undefined) {
          await tx.update(billItems).set({ price: input.subtotalAmount }).where(eq(billItems.id, itemId));
        }
        await tx.delete(itemAssignments).where(eq(itemAssignments.billItemId, itemId));
        await tx.insert(itemAssignments).values(
          splitMemberIds.map((memberId) => ({
            billItemId: itemId,
            memberId,
            splitType: "equal" as const,
          })),
        );
      }
    } else if (input.subtotalAmount !== undefined) {
      const items = await tx.query.billItems.findMany({ where: eq(billItems.billId, billId) });
      if (items[0]) {
        await tx.update(billItems).set({ price: input.subtotalAmount }).where(eq(billItems.id, items[0].id));
      }
    }

    return bill;
  });

  res.json({ data: { bill: updated } });
});

router.delete("/:id", async (req, res) => {
  const billId = Number(req.params.id);
  if (!Number.isInteger(billId)) {
    res.status(404).json({ error: { message: "Bill not found." } });
    return;
  }

  const existing = await db.query.bills.findFirst({ where: eq(bills.id, billId) });
  if (!existing) {
    res.status(404).json({ error: { message: "Bill not found." } });
    return;
  }
  const membership = await getMembership(req.session.userId!, existing.groupId);
  if (!membership) {
    res.status(404).json({ error: { message: "Bill not found." } });
    return;
  }

  await db.delete(bills).where(eq(bills.id, billId));
  res.json({ data: { success: true } });
});

export default router;
