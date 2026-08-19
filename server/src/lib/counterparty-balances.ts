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
interface GroupContribution {
  groupId: number;
  key: string;
  displayName: string;
  owedToMe: number;
  lastActivity: Date;
}

async function computeGroupContributions(membership: {
  groupId: number;
  id: number;
  joinedAt: Date;
}): Promise<GroupContribution[]> {
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

  const contributions: GroupContribution[] = [];
  for (const otherMemberId of involvedMemberIds) {
    const otherMember = memberById.get(otherMemberId);
    if (!otherMember) continue;

    contributions.push({
      groupId,
      key: otherMember.userId ? `u-${otherMember.userId}` : `m-${otherMember.id}`,
      displayName: otherMember.user?.displayName ?? otherMember.displayName,
      owedToMe: getPairwiseBalance(pairwise, otherMemberId, myMemberId),
      lastActivity: lastActivity ?? membership.joinedAt,
    });
  }
  return contributions;
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

  // One group's worth of work has no dependency on any other group's, so
  // run them all concurrently instead of one DB round-trip at a time.
  const perGroupContributions = await Promise.all(myMemberships.map(computeGroupContributions));

  const aggregate = new Map<string, CounterpartyBalance>();
  for (const contribution of perGroupContributions.flat()) {
    const existing = aggregate.get(contribution.key);
    if (existing) {
      existing.netAmount += contribution.owedToMe;
      existing.groupIds.push(contribution.groupId);
      if (contribution.lastActivity > existing.lastActivity) existing.lastActivity = contribution.lastActivity;
    } else {
      aggregate.set(contribution.key, {
        key: contribution.key,
        displayName: contribution.displayName,
        netAmount: contribution.owedToMe,
        groupIds: [contribution.groupId],
        lastActivity: contribution.lastActivity,
      });
    }
  }

  return [...aggregate.values()];
}
