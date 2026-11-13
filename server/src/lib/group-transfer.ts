import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  billItems,
  bills,
  groupMembers,
  groups,
  itemAssignments,
  settlements,
  GROUP_EXPORT_FORMAT,
  GROUP_EXPORT_VERSION,
  groupsWithMismatchedNets,
  type ExportedGroup,
  type GroupExportFile,
} from "@splittingwisdom/shared";
import { db } from "../db.js";
import { computeMemberSummary } from "./group-balance.js";
import { buildExportedGroup, type ExportedReceipts } from "./group-export-build.js";
import { deleteReceiptImage, readReceiptImage, uploadReceiptImage } from "./storage.js";

// Export and import of whole groups (see shared/group-export.ts for the file format).

/**
 * Loads the user's groups for export, or null if any of them isn't a regular group the user is
 * a member of (so nobody learns whether someone else's group exists).
 */
export async function exportGroups(userId: number, groupIds: number[], includeReceipts: boolean): Promise<GroupExportFile | null> {
  const memberships = await db.query.groupMembers.findMany({
    where: and(eq(groupMembers.userId, userId), inArray(groupMembers.groupId, groupIds)),
  });
  const loaded = await db.query.groups.findMany({
    where: and(inArray(groups.id, groupIds), eq(groups.isPersonal, false)),
    with: {
      members: true,
      bills: { with: { items: { with: { assignments: true } } } },
      settlements: true,
    },
  });
  if (memberships.length !== groupIds.length || loaded.length !== groupIds.length) return null;

  const exported: ExportedGroup[] = [];
  for (const id of groupIds) {
    const group = loaded.find((g) => g.id === id)!;
    const receipts: ExportedReceipts = new Map();
    if (includeReceipts) {
      for (const bill of group.bills) {
        if (!bill.receiptImageUrl) continue;
        try {
          const image = await readReceiptImage(bill.receiptImageUrl);
          receipts.set(bill.id, { mimeType: image.mimeType, base64: image.buffer.toString("base64") });
        } catch (err) {
          // A missing image file mustn't block exporting the money. The bill goes out without it.
          console.error(`Export: couldn't read the receipt for bill ${bill.id}:`, err);
        }
      }
    }
    exported.push(buildExportedGroup(group, memberships.find((m) => m.groupId === id)!.id, receipts));
  }

  return { format: GROUP_EXPORT_FORMAT, version: GROUP_EXPORT_VERSION, exportedAt: new Date().toISOString(), groups: exported };
}

/** A problem with the file itself, shown to the person importing it. */
export class ImportRejected extends Error {}

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/**
 * Creates every group in the file as a new group, in one transaction: all of it or none of it.
 * Existing groups are never touched. `youRefs[i]` is the member of group i who is the importer;
 * they become that member, everyone else a name-only member who can claim their name through the
 * invite link. After writing, every member's balance is recomputed from the database and compared
 * with the file's; any difference rolls the whole import back.
 */
export async function importGroups(
  file: GroupExportFile,
  youRefs: number[],
  user: { id: number; displayName: string },
): Promise<{ groupIds: number[] }> {
  if (youRefs.length !== file.groups.length) throw new ImportRejected("Choose who you are in every group.");
  file.groups.forEach((group, i) => {
    if (!group.members.some((m) => m.ref === youRefs[i])) throw new ImportRejected(`Choose who you are in "${group.name}".`);
  });
  const mismatched = groupsWithMismatchedNets(file);
  if (mismatched.length > 0) {
    throw new ImportRejected(`The balances in this file don't match its own bills for: ${mismatched.join(", ")}. The file may have been edited or damaged.`);
  }

  // Receipt images go to storage first; if anything fails after, they're deleted again.
  const stored: string[] = [];
  const receiptPaths = new Map<string, string>();
  try {
    for (const [g, group] of file.groups.entries()) {
      for (const [b, bill] of group.bills.entries()) {
        if (!bill.receipt) continue;
        const buffer = Buffer.from(bill.receipt.base64, "base64");
        if (buffer.length === 0 || buffer.length > MAX_RECEIPT_BYTES) {
          throw new ImportRejected(`The receipt photo for "${bill.description}" is damaged or too large.`);
        }
        const path = await uploadReceiptImage(buffer, bill.receipt.mimeType, user.id);
        stored.push(path);
        receiptPaths.set(`${g}:${b}`, path);
      }
    }

    const groupIds = await db.transaction(async (tx) => {
      const created: number[] = [];
      for (const [g, group] of file.groups.entries()) {
        const [newGroup] = await tx
          .insert(groups)
          .values({ name: group.name, coverImage: group.coverImage, createdBy: user.id, inviteToken: nanoid(16) })
          .returning({ id: groups.id });

        const memberIdOf = new Map<number, number>();
        for (const member of group.members) {
          const isYou = member.ref === youRefs[g];
          const [row] = await tx
            .insert(groupMembers)
            .values({
              groupId: newGroup.id,
              userId: isYou ? user.id : null,
              displayName: isYou ? user.displayName : member.displayName,
            })
            .returning({ id: groupMembers.id });
          memberIdOf.set(member.ref, row.id);
        }
        const idOf = (ref: number) => memberIdOf.get(ref)!;

        for (const [b, bill] of group.bills.entries()) {
          const [newBill] = await tx
            .insert(bills)
            .values({
              groupId: newGroup.id,
              description: bill.description,
              merchant: bill.merchant,
              billDate: bill.billDate,
              subtotalAmount: bill.subtotalAmount,
              taxAmount: bill.taxAmount,
              tipAmount: bill.tipAmount,
              serviceFeeAmount: bill.serviceFeeAmount,
              discountAmount: bill.discountAmount,
              paidByMemberId: idOf(bill.paidBy),
              payers: bill.payers ? bill.payers.map((p) => ({ memberId: idOf(p.member), amount: p.amount })) : null,
              receiptImageUrl: receiptPaths.get(`${g}:${b}`) ?? null,
              createdByUserId: user.id,
              createdAt: new Date(bill.createdAt),
            })
            .returning({ id: bills.id });

          for (const [sortOrder, item] of bill.items.entries()) {
            const [newItem] = await tx
              .insert(billItems)
              .values({ billId: newBill.id, name: item.name, price: item.price, quantity: item.quantity, sortOrder })
              .returning({ id: billItems.id });
            if (item.assignments.length > 0) {
              await tx.insert(itemAssignments).values(
                item.assignments.map((a) => ({
                  billItemId: newItem.id,
                  memberId: idOf(a.memberId),
                  splitType: a.splitType,
                  percentage: a.percentage ?? null,
                  ratio: a.ratio ?? null,
                  customAmount: a.customAmount ?? null,
                })),
              );
            }
          }
        }

        if (group.settlements.length > 0) {
          await tx.insert(settlements).values(
            group.settlements.map((s) => ({
              groupId: newGroup.id,
              payerMemberId: idOf(s.payer),
              recipientMemberId: idOf(s.recipient),
              amount: s.amount,
              note: s.note,
              settlementDate: new Date(s.settlementDate),
              createdAt: new Date(s.createdAt),
            })),
          );
        }

        // The proof: balances recomputed from what was just written must equal the file's.
        for (const { member, net } of group.nets) {
          const summary = await computeMemberSummary(newGroup.id, idOf(member), tx);
          if (summary.net !== net) {
            throw new Error(`Import check failed in "${group.name}": member ${member} came out at ${summary.net} paise, the file says ${net}.`);
          }
        }
        created.push(newGroup.id);
      }
      return created;
    });
    return { groupIds };
  } catch (err) {
    await Promise.all(stored.map((path) => deleteReceiptImage(path).catch(() => {})));
    throw err;
  }
}
