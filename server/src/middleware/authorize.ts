import type { Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db.js";
import { groups, groupMembers, type Group, type GroupMember } from "@splittingwisdom/shared";

declare global {
  namespace Express {
    interface Locals {
      groupId?: number;
      membership?: GroupMember;
      group?: Group;
    }
  }
}

/**
 * Loads the group from req.params.id / req.params.groupId, confirms the
 * current user is a member, and stashes both on res.locals. Returns 404
 * (rather than 403) for non-members so we don't reveal a group's existence
 * to people outside it.
 */
export function requireGroupMember(paramName: "id" | "groupId" = "id") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const groupId = Number(req.params[paramName]);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      res.status(404).json({ error: { message: "Group not found." } });
      return;
    }

    const group = await db.query.groups.findFirst({
      where: eq(groups.id, groupId),
    });
    if (!group) {
      res.status(404).json({ error: { message: "Group not found." } });
      return;
    }

    const membership = await db.query.groupMembers.findFirst({
      where: and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, req.session.userId!),
      ),
    });
    if (!membership) {
      res.status(404).json({ error: { message: "Group not found." } });
      return;
    }

    res.locals.groupId = groupId;
    res.locals.membership = membership;
    res.locals.group = group;
    next();
  };
}
