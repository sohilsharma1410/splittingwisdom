import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { groupMembers, getPairwiseBalance } from "@splittingwisdom/shared";
import { computeGroupBalances } from "./group-balance.js";

export interface CounterpartyBalance {
  /** "u-<userId>" for a registered counterparty (merged across shared groups), "m-<memberId>" for a name-based one (scoped to a single group). */
  key: string;
  displayName: string;
  /** Positive: they owe the current user. Negative: the current user owes them. */
  netAmount: number;
  groupIds: number[];
  lastActivity: Date;
}

/**
 * Every pairwise balance the given user has, aggregated across all groups
 * they belong to. A linked counterparty (registered, same person in
 * multiple groups) nets into one entry keyed by their user id; a
 * name-based counterparty is scoped to the one group they exist in — they
 * have no identity outside it until claimed via an invite link.
 */
export async function computeUserCounterpartyBalances(userId: number): Promise<CounterpartyBalance[]> {
  const myMemberships = await db.query.groupMembers.findMany({
    where: eq(groupMembers.userId, userId),
  });
  if (myMemberships.length === 0) return [];

  const aggregate = new Map<string, CounterpartyBalance>();

  for (const membership of myMemberships) {
    const groupId = membership.groupId;
    const myMemberId = membership.id;

    const [{ pairwise, lastActivity }, groupMembersList] = await Promise.all([
      computeGroupBalances(groupId),
      db.query.groupMembers.findMany({
        where: eq(groupMembers.groupId, groupId),
        with: { user: { columns: { id: true, displayName: true } } },
      }),
    ]);

    const memberById = new Map(groupMembersList.map((m) => [m.id, m]));

    const involvedMemberIds = new Set<number>();
    for (const pair of pairwise) {
      if (pair.memberIdA === myMemberId) involvedMemberIds.add(pair.memberIdB);
      else if (pair.memberIdB === myMemberId) involvedMemberIds.add(pair.memberIdA);
    }

    for (const otherMemberId of involvedMemberIds) {
      const otherMember = memberById.get(otherMemberId);
      if (!otherMember) continue;

      const owedToMe = getPairwiseBalance(pairwise, otherMemberId, myMemberId);
      const key = otherMember.userId ? `u-${otherMember.userId}` : `m-${otherMember.id}`;
      const displayName = otherMember.user?.displayName ?? otherMember.displayName;

      const existing = aggregate.get(key);
      if (existing) {
        existing.netAmount += owedToMe;
        existing.groupIds.push(groupId);
        if (lastActivity && lastActivity > existing.lastActivity) existing.lastActivity = lastActivity;
      } else {
        aggregate.set(key, {
          key,
          displayName,
          netAmount: owedToMe,
          groupIds: [groupId],
          lastActivity: lastActivity ?? membership.joinedAt,
        });
      }
    }
  }

  return [...aggregate.values()];
}
