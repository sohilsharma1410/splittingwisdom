import { Router } from "express";
import { and, eq, ilike, inArray, isNotNull, ne, or } from "drizzle-orm";
import { users, groupMembers } from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";

const router = Router();
router.use(requireAuth);

function normalizePhone(q: string): string {
  return q.replace(/[^\d+]/g, "");
}

// Matches on partial (fuzzy) name, or exact email/phone when the query
// looks like one — a small invite-only friend circle, not a public
// directory, so name search doesn't carry the enumeration risk that keeps
// email/phone exact-match-only.
router.get("/search", rateLimit({ max: 30, windowMs: 5 * 60 * 1000 }), async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.json({ data: { people: [] } });
    return;
  }

  const conditions = [ilike(users.displayName, `%${q}%`)];
  if (q.includes("@")) {
    conditions.push(eq(users.email, q.toLowerCase()));
  }
  const normalizedPhone = normalizePhone(q);
  if (normalizedPhone.length >= 7) {
    conditions.push(eq(users.phone, normalizedPhone));
  }

  const matches = await db.query.users.findMany({
    where: and(ne(users.id, req.session.userId!), or(...conditions)),
    columns: { id: true, displayName: true },
    limit: 20,
    orderBy: (u, { asc }) => [asc(u.displayName)],
  });

  res.json({ data: { people: matches } });
});

// Everyone the requester shares any group with today (including hidden
// individual-bill groups) — a tap-to-add shortlist so frequent
// collaborators don't need re-searching every time.
router.get("/known", async (req, res) => {
  const userId = req.session.userId!;
  const myMemberships = await db.query.groupMembers.findMany({
    where: eq(groupMembers.userId, userId),
    columns: { groupId: true },
  });
  const groupIds = myMemberships.map((m) => m.groupId);
  if (groupIds.length === 0) {
    res.json({ data: { people: [] } });
    return;
  }

  const others = await db.query.groupMembers.findMany({
    where: and(
      inArray(groupMembers.groupId, groupIds),
      isNotNull(groupMembers.userId),
      ne(groupMembers.userId, userId),
    ),
    with: { user: { columns: { id: true, displayName: true } } },
  });

  const seen = new Map<number, string>();
  for (const m of others) {
    if (m.user) seen.set(m.user.id, m.user.displayName);
  }

  const people = [...seen.entries()]
    .map(([id, displayName]) => ({ id, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  res.json({ data: { people } });
});

export default router;
