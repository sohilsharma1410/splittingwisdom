import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { eq, and, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  createBillSchema,
  updateBillSchema,
  bills,
  billItems,
  itemAssignments,
  groups,
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
import { rateLimit } from "../middleware/rate-limit.js";
import { isSupportedReceiptMimeType, uploadReceiptImage, getReceiptSignedUrl } from "../lib/storage.js";
import { extractReceipt } from "../lib/gemini.js";

const MAX_RECEIPT_IMAGE_BYTES = 10 * 1024 * 1024;
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_IMAGE_BYTES },
});

function handleReceiptUpload(req: Request, res: Response, next: NextFunction) {
  receiptUpload.single("image")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: { message: "Image must be under 10 MB." } });
      return;
    }
    next(err);
  });
}

/** Finds (or lazily creates) a hidden group for an exact set of people —
 * one person for a solo/"personal" bill, more for an individual/ad hoc
 * split with no real named group. Never has an invite flow of its own —
 * excluded from the Groups list entirely (GET /api/groups filters it out).
 * Reused whenever the exact same set of people needs another bill
 * together, so this never creates a duplicate shadow group. */
async function getOrCreateSharedGroupId(participantUserIds: number[], createdBy: number): Promise<number> {
  const sortedIds = [...new Set(participantUserIds)].sort((a, b) => a - b);

  const candidateMemberships = await db.query.groupMembers.findMany({
    where: inArray(groupMembers.userId, sortedIds),
    columns: { groupId: true },
  });
  const candidateGroupIds = [...new Set(candidateMemberships.map((m) => m.groupId))];

  if (candidateGroupIds.length > 0) {
    const candidates = await db.query.groups.findMany({
      where: and(inArray(groups.id, candidateGroupIds), eq(groups.isPersonal, true)),
      with: { members: { columns: { userId: true } } },
    });
    for (const candidate of candidates) {
      const memberUserIds = candidate.members
        .map((m) => m.userId)
        .filter((id): id is number => id !== null)
        .sort((a, b) => a - b);
      const isExactMatch =
        memberUserIds.length === sortedIds.length && memberUserIds.every((id, i) => id === sortedIds[i]);
      if (isExactMatch) return candidate.id;
    }
  }

  const participants = await db.query.users.findMany({ where: inArray(users.id, sortedIds) });
  const byId = new Map(participants.map((u) => [u.id, u]));
  const name =
    sortedIds.length === 1
      ? "Personal"
      : sortedIds
          .map((id) => byId.get(id)?.displayName ?? "Someone")
          .sort((a, b) => a.localeCompare(b))
          .join(", ");

  const newGroup = await db.transaction(async (tx) => {
    const [group] = await tx
      .insert(groups)
      .values({ name, createdBy, inviteToken: nanoid(16), isPersonal: true })
      .returning();
    await tx.insert(groupMembers).values(
      sortedIds.map((id) => ({ groupId: group.id, userId: id, displayName: byId.get(id)?.displayName ?? "Someone" })),
    );
    return group;
  });
  return newGroup.id;
}

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
      hasReceipt: bill.receiptImageUrl !== null,
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

  // No groupId means an individual bill (no real named group) — resolve
  // (or lazily create) a hidden group for the exact set of participants
  // instead. Item assignments and paidByMemberId the client sent are that
  // flow's userIds (no real memberId exists yet), so remapMemberId()
  // below translates them once the group's real members are known.
  let groupId: number;
  let userIdToMemberId: Map<number, number> | null = null;
  if (input.groupId) {
    const membership = await getMembership(req.session.userId!, input.groupId);
    if (!membership) {
      res.status(404).json({ error: { message: "Group not found." } });
      return;
    }
    groupId = input.groupId;
  } else {
    const participantUserIds = new Set(input.participantUserIds ?? []);
    participantUserIds.add(req.session.userId!);
    groupId = await getOrCreateSharedGroupId([...participantUserIds], req.session.userId!);

    const resolvedMembers = await db.query.groupMembers.findMany({ where: eq(groupMembers.groupId, groupId) });
    userIdToMemberId = new Map(
      resolvedMembers.filter((m) => m.userId !== null).map((m) => [m.userId!, m.id]),
    );
  }

  function remapMemberId(id: number): number {
    return userIdToMemberId?.get(id) ?? id;
  }

  const validMemberIds = await loadGroupMemberIds(groupId);

  let paidByMemberId = input.paidByMemberId ? remapMemberId(input.paidByMemberId) : undefined;
  if (!paidByMemberId) {
    if (input.groupId) {
      res.status(400).json({ error: { message: "Choose who paid." } });
      return;
    }
    const myMembership = await db.query.groupMembers.findFirst({
      where: and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, req.session.userId!)),
    });
    if (!myMembership) {
      res.status(400).json({ error: { message: "Could not resolve who paid." } });
      return;
    }
    paidByMemberId = myMembership.id;
  }

  const itemsToInsert: BillItemInput[] = userIdToMemberId
    ? input.items.map((item) => ({
        ...item,
        assignments: item.assignments.map((a) => ({ ...a, memberId: remapMemberId(a.memberId) })),
      }))
    : input.items;

  const referencedIds = memberIdsIn(itemsToInsert);
  const invalid = [...referencedIds].some((id) => !validMemberIds.has(id));
  if (invalid || !validMemberIds.has(paidByMemberId)) {
    res.status(400).json({ error: { message: "Selected members must belong to this group." } });
    return;
  }

  const bill = await db.transaction(async (tx) => {
    const [newBill] = await tx
      .insert(bills)
      .values({
        groupId,
        description: input.description,
        merchant: input.merchant ?? null,
        billDate: input.billDate,
        subtotalAmount: input.subtotalAmount,
        taxAmount: input.taxAmount ?? 0,
        tipAmount: input.tipAmount ?? 0,
        serviceFeeAmount: input.serviceFeeAmount ?? 0,
        discountAmount: input.discountAmount ?? 0,
        paidByMemberId,
        createdByUserId: req.session.userId!,
      })
      .returning();

    for (let i = 0; i < itemsToInsert.length; i++) {
      const itemInput = itemsToInsert[i];
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

// ---------------------------------------------------------------------------
// POST /api/bills/extract — upload a receipt photo and get back OCR'd bill
// data to prefill the create-bill form. Never a gate: the image uploads to
// Storage *before* Gemini is called, so a failed/timed-out extraction still
// returns a usable imagePath and the client falls back to manual entry with
// the photo preserved (SPEC §2.7). Rate-limited since this is the one route
// that costs real (if free-tier) external API usage per call.
// ---------------------------------------------------------------------------
router.post(
  "/extract",
  rateLimit({ max: 10, windowMs: 60 * 60 * 1000 }),
  handleReceiptUpload,
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: { message: "No image was uploaded." } });
      return;
    }
    if (!isSupportedReceiptMimeType(req.file.mimetype)) {
      res.status(400).json({ error: { message: "Please upload a JPEG, PNG, or WEBP image." } });
      return;
    }

    const imagePath = await uploadReceiptImage(req.file.buffer, req.file.mimetype, req.session.userId!);
    const extraction = await extractReceipt(req.file.buffer, req.file.mimetype);

    res.json({
      data: {
        imagePath,
        extraction,
        extractionFailed: extraction === null,
      },
    });
  },
);

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
        groupIsPersonal: bill.group.isPersonal,
        hasReceipt: bill.receiptImageUrl !== null,
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

// ---------------------------------------------------------------------------
// POST /api/bills/:id/receipt — attach/replace a receipt photo on an
// existing bill. Uploads to private Supabase Storage; only the bucket path
// is stored (in receiptImageUrl, despite the name) — never a public URL.
// ---------------------------------------------------------------------------
router.post("/:id/receipt", handleReceiptUpload, async (req, res) => {
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

  if (!req.file) {
    res.status(400).json({ error: { message: "No image was uploaded." } });
    return;
  }
  if (!isSupportedReceiptMimeType(req.file.mimetype)) {
    res.status(400).json({ error: { message: "Please upload a JPEG, PNG, or WEBP image." } });
    return;
  }

  const path = await uploadReceiptImage(req.file.buffer, req.file.mimetype, req.session.userId!);
  await db.update(bills).set({ receiptImageUrl: path, updatedAt: new Date() }).where(eq(bills.id, billId));

  res.status(201).json({ data: { success: true } });
});

// ---------------------------------------------------------------------------
// GET /api/bills/:id/receipt-url — a short-lived signed URL for this bill's
// receipt image, scoped to the requester's group membership. Never persist
// this URL client-side beyond the current view — it expires in 10 minutes.
// ---------------------------------------------------------------------------
router.get("/:id/receipt-url", async (req, res) => {
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
  if (!existing.receiptImageUrl) {
    res.status(404).json({ error: { message: "This bill has no receipt image." } });
    return;
  }

  const url = await getReceiptSignedUrl(existing.receiptImageUrl);
  res.json({ data: { url } });
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
