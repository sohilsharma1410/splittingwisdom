import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { eq, inArray, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  insertGroupSchema,
  groups,
  groupMembers,
  users,
  bills,
  settlements,
  billGrandTotal,
  listDirectDebts,
  simplifyDebts,
  summarizeMember,
  groupExportFileSchema,
  groupExportRequestSchema,
  groupImportChoicesSchema,
} from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireGroupMember } from "../middleware/authorize.js";
import { idempotency } from "../middleware/idempotency.js";
import { computeGroupBalances, memberNetBalance, toBillForSummary, toSettlementForBalance } from "../lib/group-balance.js";
import { loadBillStatuses } from "../lib/bill-status.js";
import { exportGroups, importGroups, ImportRejected } from "../lib/group-transfer.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { isForeignKeyViolation, isUniqueViolation } from "../lib/pg-errors.js";

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/groups — groups the current user is a member of
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const myMemberships = await db.query.groupMembers.findMany({
    where: eq(groupMembers.userId, req.session.userId!),
  });
  const groupIds = myMemberships.map((m) => m.groupId);

  if (groupIds.length === 0) {
    res.json({ data: { groups: [] } });
    return;
  }

  const rows = await db.query.groups.findMany({
    where: and(inArray(groups.id, groupIds), eq(groups.isPersonal, false)),
    with: {
      members: true,
      bills: { columns: { id: true, createdAt: true } },
    },
  });
  const myMemberIdByGroup = new Map(myMemberships.map((m) => [m.groupId, m.id]));

  const result = await Promise.all(
    rows.map(async (group) => {
      const { pairwise, lastActivity } = await computeGroupBalances(group.id);
      const myMemberId = myMemberIdByGroup.get(group.id)!;
      const myBalance = memberNetBalance(
        pairwise,
        myMemberId,
        group.members.map((m) => m.id),
      );

      return {
        id: group.id,
        name: group.name,
        coverImage: group.coverImage,
        memberCount: group.members.length,
        billCount: group.bills.length,
        myBalance,
        memberPreview: group.members.slice(0, 5).map((m) => m.displayName),
        lastActivity: lastActivity ?? group.updatedAt,
      };
    }),
  );

  res.json({ data: { groups: result } });
});

// ---------------------------------------------------------------------------
// POST /api/groups — create a group with the creator as the sole member.
// Everyone else is added by direct search (POST /:id/members) or joins via
// the invite link — never a free-text member entry.
// ---------------------------------------------------------------------------
router.post("/", idempotency(), async (req, res) => {
  const parsed = insertGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }
  const { name, coverImage } = parsed.data;

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, req.session.userId!),
  });
  if (!currentUser) {
    res.status(401).json({ error: { message: "You need to be logged in." } });
    return;
  }

  const group = await db.transaction(async (tx) => {
    const [newGroup] = await tx
      .insert(groups)
      .values({
        name,
        coverImage: coverImage ?? null,
        createdBy: currentUser.id,
        inviteToken: nanoid(16),
      })
      .returning();

    await tx
      .insert(groupMembers)
      .values({ groupId: newGroup.id, userId: currentUser.id, displayName: currentUser.displayName });

    return newGroup;
  });

  res.status(201).json({ data: { group } });
});

// ---------------------------------------------------------------------------
// GET /api/groups/export?ids=1,2&receipts=true — download groups as one file
// ---------------------------------------------------------------------------
router.get("/export", rateLimit({ max: 30, windowMs: 60 * 60 * 1000, message: "Too many exports this hour. Try again later." }), async (req, res) => {
  const parsed = groupExportRequestSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }
  const file = await exportGroups(req.session.userId!, parsed.data.ids, parsed.data.receipts);
  if (!file) {
    res.status(404).json({ error: { message: "One of those groups wasn't found." } });
    return;
  }
  res.json({ data: file });
});

// ---------------------------------------------------------------------------
// POST /api/groups/import — multipart: `file` (an export) and `you` (JSON array: for each group
// in the file, the ref of the member who is the importer). Always creates new groups.
// ---------------------------------------------------------------------------
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });

function handleImportUpload(req: Request, res: Response, next: NextFunction) {
  importUpload.single("file")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: { message: "The file must be under 100 MB." } });
      return;
    }
    next(err);
  });
}

router.post(
  "/import",
  rateLimit({ max: 10, windowMs: 60 * 60 * 1000, message: "Too many imports this hour. Try again later." }),
  handleImportUpload,
  idempotency(),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: { message: "Choose an export file to import." } });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(req.file.buffer.toString("utf8"));
    } catch {
      res.status(400).json({ error: { message: "That file isn't a SplittingWisdom export (it isn't valid JSON)." } });
      return;
    }
    const file = groupExportFileSchema.safeParse(json);
    if (!file.success) {
      const issue = file.error.issues[0];
      res.status(400).json({ error: { message: `The file can't be imported: ${issue.message}${issue.path.length ? ` (at ${issue.path.join(".")})` : ""}` } });
      return;
    }
    let you: unknown;
    try {
      you = JSON.parse(String(req.body?.you ?? ""));
    } catch {
      you = null;
    }
    const choices = groupImportChoicesSchema.safeParse(you);
    if (!choices.success) {
      res.status(400).json({ error: { message: "Choose who you are in every group." } });
      return;
    }

    const user = await db.query.users.findFirst({ where: eq(users.id, req.session.userId!) });
    if (!user) {
      res.status(401).json({ error: { message: "You need to be logged in." } });
      return;
    }

    try {
      const result = await importGroups(file.data, choices.data, { id: user.id, displayName: user.displayName });
      res.status(201).json({ data: result });
    } catch (err) {
      if (err instanceof ImportRejected) {
        res.status(400).json({ error: { message: err.message } });
        return;
      }
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/groups/:id — full detail
// ---------------------------------------------------------------------------
router.get("/:id", requireGroupMember("id"), async (req, res) => {
  const group = await db.query.groups.findFirst({
    where: eq(groups.id, res.locals.groupId!),
    with: {
      members: { with: { user: { columns: { id: true, displayName: true, email: true } } } },
    },
  });
  if (!group) {
    res.status(404).json({ error: { message: "Group not found." } });
    return;
  }

  const { pairwise } = await computeGroupBalances(group.id);
  const allMemberIds = group.members.map((m) => m.id);

  res.json({
    data: {
      group: {
        ...group,
        members: group.members.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          userId: m.userId,
          isLinked: m.userId !== null,
          joinedAt: m.joinedAt,
          balance: memberNetBalance(pairwise, m.id, allMemberIds),
        })),
        // Today's direct debts and the reduced set of payments that would
        // settle everyone — a suggestion only; the ledger is untouched.
        debts: listDirectDebts(pairwise),
        simplifiedPayments: simplifyDebts(pairwise),
      },
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/groups/:id/bills — bills for this group, newest first
// ---------------------------------------------------------------------------
router.get("/:id/bills", requireGroupMember("id"), async (req, res) => {
  const groupId = res.locals.groupId!;
  const [groupBills, groupSettlements, statuses] = await Promise.all([
    db.query.bills.findMany({
      where: eq(bills.groupId, groupId),
      with: { paidBy: true, items: { with: { assignments: true } } },
      orderBy: (b, { desc }) => [desc(b.createdAt)],
    }),
    db.query.settlements.findMany({ where: eq(settlements.groupId, groupId) }),
    loadBillStatuses([groupId]),
  ]);

  const { billShares, ...summary } = summarizeMember(
    groupBills.map(toBillForSummary),
    groupSettlements.map(toSettlementForBalance),
    res.locals.membership!.id,
  );

  res.json({
    data: {
      summary,
      bills: groupBills.map((b, index) => ({
        id: b.id,
        description: b.description,
        merchant: b.merchant,
        billDate: b.billDate,
        grandTotal: billGrandTotal(b),
        myShare: billShares[index],
        paidByName: b.paidBy.displayName,
        status: statuses.get(b.id) ?? "pending",
        createdAt: b.createdAt,
      })),
    },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/groups/:id — rename (any member may rename)
// ---------------------------------------------------------------------------
router.patch("/:id", requireGroupMember("id"), async (req, res) => {
  const parsed = insertGroupSchema.pick({ name: true }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }

  const [updated] = await db
    .update(groups)
    .set({ name: parsed.data.name, updatedAt: new Date() })
    .where(eq(groups.id, res.locals.groupId!))
    .returning();

  res.json({ data: { group: updated } });
});

// ---------------------------------------------------------------------------
// DELETE /api/groups/:id — creator only (cascades to members/bills/etc.)
// ---------------------------------------------------------------------------
router.delete("/:id", requireGroupMember("id"), async (req, res) => {
  if (res.locals.group!.createdBy !== req.session.userId) {
    res
      .status(403)
      .json({ error: { message: "Only the group creator can delete this group." } });
    return;
  }

  const groupId = res.locals.groupId!;
  await db.transaction(async (tx) => {
    // item_assignments.memberId and settlements' member columns intentionally
    // don't cascade from group_members (removing a single member with bill
    // history must be blocked, not silently corrupt their share) — so
    // deleting the whole group must clear bills/settlements (which cascade
    // down to item_assignments) *before* the group delete below cascades to
    // group_members, or that cascade hits the same protective constraint.
    await tx.delete(bills).where(eq(bills.groupId, groupId));
    await tx.delete(settlements).where(eq(settlements.groupId, groupId));
    await tx.delete(groups).where(eq(groups.id, groupId));
  });
  res.json({ data: { success: true } });
});

// ---------------------------------------------------------------------------
// POST /api/groups/:id/members — add an already-registered user directly
// (found via search). Never accepts a free-text name — that ban from
// Phase 3 §1 stands; this is a second, equally strict path to a real
// account, alongside the invite link, not a reopening of it.
// ---------------------------------------------------------------------------
router.post("/:id/members", requireGroupMember("id"), idempotency(), async (req, res) => {
  const userId = Number(req.body?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: { message: "Choose someone to add." } });
    return;
  }

  const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!targetUser) {
    res.status(404).json({ error: { message: "That person couldn't be found." } });
    return;
  }

  try {
    const [member] = await db
      .insert(groupMembers)
      .values({ groupId: res.locals.groupId!, userId: targetUser.id, displayName: targetUser.displayName })
      .returning();
    res.status(201).json({ data: { member } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: { message: "Already in this group." } });
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/groups/:id/members/:memberId — creator only
// ---------------------------------------------------------------------------
router.delete("/:id/members/:memberId", requireGroupMember("id"), async (req, res) => {
  if (res.locals.group!.createdBy !== req.session.userId) {
    res
      .status(403)
      .json({ error: { message: "Only the group creator can remove members." } });
    return;
  }

  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(memberId)) {
    res.status(404).json({ error: { message: "Member not found." } });
    return;
  }

  try {
    const deleted = await db
      .delete(groupMembers)
      .where(and(eq(groupMembers.id, memberId), eq(groupMembers.groupId, res.locals.groupId!)))
      .returning();

    if (deleted.length === 0) {
      res.status(404).json({ error: { message: "Member not found." } });
      return;
    }
    res.json({ data: { success: true } });
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      res.status(409).json({
        error: {
          message: "Can't remove someone who's paid for or is part of a bill in this group.",
        },
      });
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/groups/invite/:token — invite preview (auth required)
// ---------------------------------------------------------------------------
router.get("/invite/:token", async (req, res) => {
  const group = await db.query.groups.findFirst({
    where: eq(groups.inviteToken, req.params.token),
    with: { members: true },
  });
  if (!group) {
    res.status(404).json({ error: { message: "That invite link is no longer valid." } });
    return;
  }

  const alreadyMember = group.members.some((m) => m.userId === req.session.userId);
  const unclaimedMembers = group.members
    .filter((m) => m.userId === null)
    .map((m) => ({ id: m.id, displayName: m.displayName }));

  res.json({
    data: {
      group: { id: group.id, name: group.name },
      alreadyMember,
      unclaimedMembers,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/groups/invite/:token/join — claim a name-based slot, or join new
// ---------------------------------------------------------------------------
router.post("/invite/:token/join", async (req, res) => {
  const group = await db.query.groups.findFirst({
    where: eq(groups.inviteToken, req.params.token),
  });
  if (!group) {
    res.status(404).json({ error: { message: "That invite link is no longer valid." } });
    return;
  }

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, req.session.userId!),
  });
  if (!currentUser) {
    res.status(401).json({ error: { message: "You need to be logged in." } });
    return;
  }

  const memberId = req.body?.memberId ? Number(req.body.memberId) : undefined;

  try {
    if (memberId !== undefined) {
      const [claimed] = await db
        .update(groupMembers)
        .set({ userId: currentUser.id })
        .where(
          and(
            eq(groupMembers.id, memberId),
            eq(groupMembers.groupId, group.id),
            isNull(groupMembers.userId),
          ),
        )
        .returning();

      if (!claimed) {
        res
          .status(409)
          .json({ error: { message: "That slot has already been claimed." } });
        return;
      }
      res.json({ data: { group: { id: group.id, name: group.name } } });
      return;
    }

    await db
      .insert(groupMembers)
      .values({ groupId: group.id, userId: currentUser.id, displayName: currentUser.displayName });
    res.json({ data: { group: { id: group.id, name: group.name } } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: { message: "You're already in this group." } });
      return;
    }
    throw err;
  }
});

export default router;
