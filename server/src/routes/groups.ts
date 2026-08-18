import { Router } from "express";
import { eq, inArray, and, isNull, ilike } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  createGroupSchema,
  insertGroupSchema,
  addMemberSchema,
  groups,
  groupMembers,
  users,
  bills,
  billGrandTotal,
} from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireGroupMember } from "../middleware/authorize.js";
import { computeGroupBalances, memberNetBalance } from "../lib/group-balance.js";

const router = Router();
router.use(requireAuth);

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23503"
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

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
    where: inArray(groups.id, groupIds),
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
// POST /api/groups — create a group with the creator + name-based members
// ---------------------------------------------------------------------------
router.post("/", async (req, res) => {
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }
  const { name, coverImage, memberNames } = parsed.data;

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, req.session.userId!),
  });
  if (!currentUser) {
    res.status(401).json({ error: { message: "You need to be logged in." } });
    return;
  }

  const seen = new Set<string>([currentUser.displayName.trim().toLowerCase()]);
  const dedupedNames = memberNames.filter((n) => {
    const key = n.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

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

    await tx.insert(groupMembers).values([
      { groupId: newGroup.id, userId: currentUser.id, displayName: currentUser.displayName },
      ...dedupedNames.map((displayName) => ({ groupId: newGroup.id, displayName })),
    ]);

    return newGroup;
  });

  res.status(201).json({ data: { group } });
});

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
      },
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/groups/:id/bills — bills for this group, newest first
// ---------------------------------------------------------------------------
router.get("/:id/bills", requireGroupMember("id"), async (req, res) => {
  const groupBills = await db.query.bills.findMany({
    where: eq(bills.groupId, res.locals.groupId!),
    with: { paidBy: true },
    orderBy: (b, { desc }) => [desc(b.createdAt)],
  });

  res.json({
    data: {
      bills: groupBills.map((b) => ({
        id: b.id,
        description: b.description,
        merchant: b.merchant,
        billDate: b.billDate,
        grandTotal: billGrandTotal(b),
        paidByName: b.paidBy.displayName,
        status: b.status,
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

  await db.delete(groups).where(eq(groups.id, res.locals.groupId!));
  res.json({ data: { success: true } });
});

// ---------------------------------------------------------------------------
// POST /api/groups/:id/members — add a name-based member
// ---------------------------------------------------------------------------
router.post("/:id/members", requireGroupMember("id"), async (req, res) => {
  const parsed = addMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }

  const existing = await db.query.groupMembers.findFirst({
    where: and(
      eq(groupMembers.groupId, res.locals.groupId!),
      ilike(groupMembers.displayName, parsed.data.displayName.trim()),
    ),
  });
  if (existing) {
    res
      .status(409)
      .json({ error: { message: `${parsed.data.displayName} is already in this group.` } });
    return;
  }

  const [member] = await db
    .insert(groupMembers)
    .values({ groupId: res.locals.groupId!, displayName: parsed.data.displayName })
    .returning();

  res.status(201).json({ data: { member } });
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
