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
  billGrandTotal,
  computeBillBreakdown,
  computeItemShares,
  type BillItemForBalance,
  type BillItemInput,
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

/** Every member id referenced anywhere in an item list (assignments only — a
 * price alone doesn't reference a person). */
function memberIdsIn(items: BillItemInput[]): Set<number> {
  const ids = new Set<number>();
  for (const item of items) {
    for (const a of item.assignments) ids.add(a.memberId);
  }
  return ids;
}

type DbBillItem = {
  id: number;
  name: string;
  price: number;
  quantity: number;
  assignments: {
    memberId: number;
    splitType: "equal" | "percentage" | "ratio" | "custom";
    percentage: number | null;
    ratio: number | null;
    customAmount: number | null;
    member: { displayName: string };
  }[];
};

function toBalanceItems(items: DbBillItem[]): BillItemForBalance[] {
  return items.map((item) => ({
    price: item.price,
    assignments: item.assignments.map((a) => ({
      memberId: a.memberId,
      splitType: a.splitType,
      percentage: a.percentage,
      ratio: a.ratio,
      customAmount: a.customAmount,
    })),
  }));
}

/** Item list for the client: each item with its assignments' computed
 * per-person share, ready to render without re-deriving anything. */
function buildItemsResponse(items: DbBillItem[]) {
  return items.map((item) => {
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
    return {
      id: item.id,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      assignments: item.assignments.map((a) => ({
        memberId: a.memberId,
        displayName: a.member.displayName,
        splitType: a.splitType,
        percentage: a.percentage,
        ratio: a.ratio,
        customAmount: a.customAmount,
        share: shares.get(a.memberId) ?? 0,
      })),
    };
  });
}

function buildBreakdownResponse(items: DbBillItem[], bill: {
  paidByMemberId: number;
  taxAmount: number;
  tipAmount: number;
  serviceFeeAmount: number;
  discountAmount: number;
}) {
  const memberNames = new Map<number, string>();
  for (const item of items) {
    for (const a of item.assignments) memberNames.set(a.memberId, a.member.displayName);
  }
  const breakdown = computeBillBreakdown({ ...bill, items: toBalanceItems(items) });
  return breakdown.map((row) => ({ ...row, displayName: memberNames.get(row.memberId) ?? "Unknown" }));
}

// ---------------------------------------------------------------------------
// GET /api/bills — every bill across every group the current user is in,
// newest first. Powers the Activity page and the Dashboard's recent list.
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const myMemberships = await db.query.groupMembers.findMany({
    where: eq(groupMembers.userId, req.session.userId!),
  });
  if (myMemberships.length === 0) {
    res.json({ data: { bills: [] } });
    return;
  }
  const myMemberIdByGroup = new Map(myMemberships.map((m) => [m.groupId, m.id]));

  const allBills = await db.query.bills.findMany({
    where: (b, { inArray }) => inArray(b.groupId, myMemberships.map((m) => m.groupId)),
    with: {
      group: { columns: { name: true } },
      paidBy: true,
      items: { with: { assignments: { with: { member: true } } }, orderBy: (i, { asc }) => [asc(i.sortOrder)] },
    },
    orderBy: (b, { desc }) => [desc(b.createdAt)],
  });

  const result = allBills.map((bill) => {
    const breakdown = buildBreakdownResponse(bill.items, bill);
    const myMemberId = myMemberIdByGroup.get(bill.groupId);
    const myShare = breakdown.find((b) => b.memberId === myMemberId)?.total ?? 0;
    const assignedItemCount = bill.items.filter((i) => i.assignments.length > 0).length;

    return {
      id: bill.id,
      groupId: bill.groupId,
      groupName: bill.group.name,
      description: bill.description,
      merchant: bill.merchant,
      billDate: bill.billDate,
      grandTotal: billGrandTotal(bill),
      itemCount: bill.items.length,
      unassignedItemCount: bill.items.length - assignedItemCount,
      paidByName: bill.paidBy.displayName,
      status: bill.status,
      myShare,
      createdAt: bill.createdAt,
      items: buildItemsResponse(bill.items).map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        assignments: item.assignments,
      })),
      breakdown: breakdown.map((b) => ({
        memberId: b.memberId,
        displayName: b.displayName,
        total: b.total,
      })),
    };
  });

  res.json({ data: { bills: result } });
});

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
  const referencedIds = memberIdsIn(input.items);
  const invalid = [...referencedIds].some((id) => !validMemberIds.has(id));
  if (invalid || !validMemberIds.has(input.paidByMemberId)) {
    res.status(400).json({ error: { message: "Selected members must belong to this group." } });
    return;
  }

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

    for (let i = 0; i < input.items.length; i++) {
      const itemInput = input.items[i];
      const [item] = await tx
        .insert(billItems)
        .values({
          billId: newBill.id,
          name: itemInput.name,
          price: itemInput.price,
          quantity: itemInput.quantity ?? 1,
          sortOrder: i,
        })
        .returning();

      if (itemInput.assignments.length > 0) {
        await tx.insert(itemAssignments).values(
          itemInput.assignments.map((a) => ({
            billItemId: item.id,
            memberId: a.memberId,
            splitType: a.splitType,
            percentage: a.percentage ?? null,
            ratio: a.ratio ?? null,
            customAmount: a.customAmount ?? null,
          })),
        );
      }
    }

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
      items: { with: { assignments: { with: { member: true } } }, orderBy: (i, { asc }) => [asc(i.sortOrder)] },
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

  const items = buildItemsResponse(bill.items);
  const breakdown = buildBreakdownResponse(bill.items, bill);
  const itemsSubtotal = bill.items.reduce((sum, item) => sum + item.price, 0);
  const assignedItemCount = bill.items.filter((i) => i.assignments.length > 0).length;

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
        itemsSubtotal,
        taxAmount: bill.taxAmount,
        tipAmount: bill.tipAmount,
        serviceFeeAmount: bill.serviceFeeAmount,
        discountAmount: bill.discountAmount,
        grandTotal: billGrandTotal(bill),
        paidByMemberId: bill.paidByMemberId,
        paidByName: bill.paidBy.displayName,
        status: bill.status,
        createdByName: createdBy?.displayName ?? "Someone",
        lastEditedByName: lastEditedBy?.displayName ?? null,
        lastEditedAt: bill.lastEditedAt,
        createdAt: bill.createdAt,
        updatedAt: bill.updatedAt,
        items,
        itemCount: items.length,
        unassignedItemCount: items.length - assignedItemCount,
        breakdown,
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
  if (input.items) {
    const referencedIds = memberIdsIn(input.items);
    if ([...referencedIds].some((id) => !validMemberIds.has(id))) {
      res.status(400).json({ error: { message: "Selected members must belong to this group." } });
      return;
    }
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

    // Items, when provided, fully replace the bill's existing items and
    // assignments — same "whole document" pattern Phase 1 used for the
    // single "Entire bill" item, generalized to a real item list.
    if (input.items) {
      const oldItems = await tx.query.billItems.findMany({ where: eq(billItems.billId, billId) });
      if (oldItems.length > 0) {
        await tx.delete(billItems).where(eq(billItems.billId, billId));
      }

      for (let i = 0; i < input.items.length; i++) {
        const itemInput = input.items[i];
        const [item] = await tx
          .insert(billItems)
          .values({
            billId,
            name: itemInput.name,
            price: itemInput.price,
            quantity: itemInput.quantity ?? 1,
            sortOrder: i,
          })
          .returning();

        if (itemInput.assignments.length > 0) {
          await tx.insert(itemAssignments).values(
            itemInput.assignments.map((a) => ({
              billItemId: item.id,
              memberId: a.memberId,
              splitType: a.splitType,
              percentage: a.percentage ?? null,
              ratio: a.ratio ?? null,
              customAmount: a.customAmount ?? null,
            })),
          );
        }
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
