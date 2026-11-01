import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { groupMembers } from "@splittingwisdom/shared";

export function parsePersonId(personId: string): { type: "user" | "member"; id: number } | null {
  const match = /^([um])-(\d+)$/.exec(personId);
  if (!match) return null;
  return { type: match[1] === "u" ? "user" : "member", id: Number(match[2]) };
}

export interface PersonTarget {
  groupId: number;
  myMemberId: number;
  counterpartyMemberId: number;
}

/**
 * Every group where `personId` and the current user are both members, with
 * each side's member id there. A registered person ("u-…") can appear in
 * several shared groups; a name-only member ("m-…") exists in exactly one.
 * Groups the current user isn't in never appear, so this is also the
 * authorization boundary for person-level balance and settlement requests.
 */
export async function resolvePersonTargets(userId: number, personId: string): Promise<PersonTarget[]> {
  const parsed = parsePersonId(personId);
  if (!parsed) return [];

  const mine = await db.query.groupMembers.findMany({ where: eq(groupMembers.userId, userId) });
  const myMemberByGroup = new Map(mine.map((m) => [m.groupId, m.id]));

  const theirs =
    parsed.type === "user"
      ? await db.query.groupMembers.findMany({ where: eq(groupMembers.userId, parsed.id) })
      : await db.query.groupMembers.findMany({ where: eq(groupMembers.id, parsed.id) });

  return theirs
    .filter((row) => myMemberByGroup.has(row.groupId) && row.id !== myMemberByGroup.get(row.groupId))
    .map((row) => ({
      groupId: row.groupId,
      myMemberId: myMemberByGroup.get(row.groupId)!,
      counterpartyMemberId: row.id,
    }))
    .sort((a, b) => a.groupId - b.groupId);
}
