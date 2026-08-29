import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  date,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { percentageGap, customAmountRemaining, isValidRatioPart } from "./lib/money.js";

export const BILL_STATUSES = ["pending", "settled"] as const;
export const SPLIT_TYPES = ["equal", "percentage", "ratio", "custom"] as const;

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  groupMemberships: many(groupMembers),
  createdGroups: many(groups),
}));

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------
export const groups = pgTable("groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  coverImage: text("cover_image"),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id),
  inviteToken: text("invite_token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const groupsRelations = relations(groups, ({ one, many }) => ({
  creator: one(users, {
    fields: [groups.createdBy],
    references: [users.id],
  }),
  members: many(groupMembers),
  bills: many(bills),
  settlements: many(settlements),
}));

// ---------------------------------------------------------------------------
// group_members — either linked to a user account, or a plain display name
// ---------------------------------------------------------------------------
export const groupMembers = pgTable(
  "group_members",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id),
    displayName: text("display_name").notNull(),
    joinedAt: timestamp("joined_at").notNull().defaultNow(),
  },
  (table) => [unique().on(table.groupId, table.userId)],
);

export const groupMembersRelations = relations(groupMembers, ({ one, many }) => ({
  group: one(groups, {
    fields: [groupMembers.groupId],
    references: [groups.id],
  }),
  user: one(users, {
    fields: [groupMembers.userId],
    references: [users.id],
  }),
  itemAssignments: many(itemAssignments),
  billsPaid: many(bills),
}));

// ---------------------------------------------------------------------------
// bills — amounts are pre-tax subtotal + separate charge columns, all paise.
// Grand total (subtotal + tax + tip + serviceFee - discount) is derived, not
// stored.
// ---------------------------------------------------------------------------
export const bills = pgTable("bills", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  merchant: text("merchant"),
  billDate: date("bill_date").notNull(),
  subtotalAmount: integer("subtotal_amount").notNull(),
  taxAmount: integer("tax_amount").notNull().default(0),
  tipAmount: integer("tip_amount").notNull().default(0),
  serviceFeeAmount: integer("service_fee_amount").notNull().default(0),
  discountAmount: integer("discount_amount").notNull().default(0),
  paidByMemberId: integer("paid_by_member_id")
    .notNull()
    .references(() => groupMembers.id),
  receiptImageUrl: text("receipt_image_url"),
  status: text("status", { enum: BILL_STATUSES }).notNull().default("pending"),
  createdByUserId: integer("created_by_user_id")
    .notNull()
    .references(() => users.id),
  lastEditedByUserId: integer("last_edited_by_user_id").references(
    () => users.id,
  ),
  lastEditedAt: timestamp("last_edited_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const billsRelations = relations(bills, ({ one, many }) => ({
  group: one(groups, {
    fields: [bills.groupId],
    references: [groups.id],
  }),
  paidBy: one(groupMembers, {
    fields: [bills.paidByMemberId],
    references: [groupMembers.id],
  }),
  items: many(billItems),
}));

// ---------------------------------------------------------------------------
// bill_items — Phase 1 always creates exactly one "Entire bill" item per bill
// ---------------------------------------------------------------------------
export const billItems = pgTable("bill_items", {
  id: serial("id").primaryKey(),
  billId: integer("bill_id")
    .notNull()
    .references(() => bills.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  price: integer("price").notNull(),
  quantity: integer("quantity").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const billItemsRelations = relations(billItems, ({ one, many }) => ({
  bill: one(bills, {
    fields: [billItems.billId],
    references: [bills.id],
  }),
  assignments: many(itemAssignments),
}));

// ---------------------------------------------------------------------------
// item_assignments — Phase 1 always writes splitType = "equal" rows, one per
// selected member, with percentage/ratio/customAmount left null. Later
// phases populate those columns for non-equal splits without a schema change.
// ---------------------------------------------------------------------------
export const itemAssignments = pgTable("item_assignments", {
  id: serial("id").primaryKey(),
  billItemId: integer("bill_item_id")
    .notNull()
    .references(() => billItems.id, { onDelete: "cascade" }),
  memberId: integer("member_id")
    .notNull()
    .references(() => groupMembers.id, { onDelete: "cascade" }),
  splitType: text("split_type", { enum: SPLIT_TYPES }).notNull().default("equal"),
  percentage: integer("percentage"),
  ratio: integer("ratio"),
  customAmount: integer("custom_amount"),
});

export const itemAssignmentsRelations = relations(itemAssignments, ({ one }) => ({
  item: one(billItems, {
    fields: [itemAssignments.billItemId],
    references: [billItems.id],
  }),
  member: one(groupMembers, {
    fields: [itemAssignments.memberId],
    references: [groupMembers.id],
  }),
}));

// ---------------------------------------------------------------------------
// settlements — schema defined in Phase 1, populated starting Phase 4
// ---------------------------------------------------------------------------
export const settlements = pgTable("settlements", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  payerMemberId: integer("payer_member_id")
    .notNull()
    .references(() => groupMembers.id),
  recipientMemberId: integer("recipient_member_id")
    .notNull()
    .references(() => groupMembers.id),
  amount: integer("amount").notNull(),
  note: text("note"),
  settlementDate: timestamp("settlement_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const settlementsRelations = relations(settlements, ({ one }) => ({
  group: one(groups, {
    fields: [settlements.groupId],
    references: [groups.id],
  }),
  payer: one(groupMembers, {
    fields: [settlements.payerMemberId],
    references: [groupMembers.id],
  }),
  recipient: one(groupMembers, {
    fields: [settlements.recipientMemberId],
    references: [groupMembers.id],
  }),
}));

// ---------------------------------------------------------------------------
// Zod schemas derived from the tables above — the shared validation contract
// for both client forms and server route handlers.
// ---------------------------------------------------------------------------
export const insertUserSchema = createInsertSchema(users, {
  email: (schema) => schema.email("Enter a valid email address"),
  displayName: (schema) => schema.min(1, "Name is required").max(80),
}).pick({ email: true, displayName: true });

export const registerSchema = insertUserSchema.extend({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export const selectUserSchema = createSelectSchema(users).omit({
  passwordHash: true,
});

export const insertGroupSchema = createInsertSchema(groups, {
  name: (schema) => schema.min(1, "Group name is required").max(100),
}).pick({ name: true, coverImage: true });

export const createGroupSchema = insertGroupSchema.extend({
  memberNames: z
    .array(z.string().min(1).max(80))
    .max(50, "That's a lot of members — split into smaller groups"),
});

export const selectGroupSchema = createSelectSchema(groups);
export const selectGroupMemberSchema = createSelectSchema(groupMembers);

export const addMemberSchema = z.object({
  displayName: z.string().min(1, "Name is required").max(80),
});

export const insertBillSchema = createInsertSchema(bills, {
  description: (schema) => schema.min(1, "Description is required").max(200),
  subtotalAmount: (schema) => schema.int().positive(),
  taxAmount: (schema) => schema.int().nonnegative(),
  tipAmount: (schema) => schema.int().nonnegative(),
  serviceFeeAmount: (schema) => schema.int().nonnegative(),
  discountAmount: (schema) => schema.int().nonnegative(),
}).pick({
  description: true,
  merchant: true,
  billDate: true,
  subtotalAmount: true,
  taxAmount: true,
  tipAmount: true,
  serviceFeeAmount: true,
  discountAmount: true,
  paidByMemberId: true,
});

// ---------------------------------------------------------------------------
// Item assignments — one split type per item (the assignment editor has one
// split-type selector per item, not per person). percentage/ratio/custom
// each require their own value field; equal requires none.
// ---------------------------------------------------------------------------
export const itemAssignmentInputSchema = z
  .object({
    memberId: z.number().int().positive(),
    splitType: z.enum(SPLIT_TYPES),
    percentage: z.number().int().min(1).max(100).nullish(),
    ratio: z.number().int().positive().nullish(),
    customAmount: z.number().int().positive().nullish(),
  })
  .superRefine((a, ctx) => {
    if (a.splitType === "percentage" && a.percentage == null) {
      ctx.addIssue({ code: "custom", path: ["percentage"], message: "Percentage is required for a percentage split." });
    }
    if (a.splitType === "ratio" && a.ratio == null) {
      ctx.addIssue({ code: "custom", path: ["ratio"], message: "Ratio is required for a ratio split." });
    }
    if (a.splitType === "custom" && a.customAmount == null) {
      ctx.addIssue({ code: "custom", path: ["customAmount"], message: "Custom amount is required for a custom split." });
    }
  });

export const billItemInputSchema = z
  .object({
    name: z.string().min(1, "Item name is required").max(200),
    price: z.number().int().positive("Item price must be greater than zero"),
    quantity: z.number().int().positive().default(1),
    assignments: z.array(itemAssignmentInputSchema),
  })
  .superRefine((item, ctx) => {
    if (item.assignments.length === 0) return; // unassigned is allowed — flagged in the UI, not rejected

    const splitTypes = new Set(item.assignments.map((a) => a.splitType));
    if (splitTypes.size > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["assignments"],
        message: `"${item.name}": all assignments on one item must use the same split type.`,
      });
      return;
    }

    const splitType = item.assignments[0].splitType;
    if (splitType === "percentage") {
      const gap = percentageGap(item.assignments.map((a) => a.percentage ?? 0));
      if (gap !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["assignments"],
          message:
            gap > 0
              ? `"${item.name}": percentages are ${gap} short of 100.`
              : `"${item.name}": percentages are ${-gap} over 100.`,
        });
      }
    }
    if (splitType === "custom") {
      const remaining = customAmountRemaining(item.assignments.map((a) => a.customAmount ?? 0), item.price);
      if (remaining !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["assignments"],
          message:
            remaining > 0
              ? `"${item.name}": ${formatPaiseForMessage(remaining)} left to assign.`
              : `"${item.name}": custom amounts exceed the item price.`,
        });
      }
    }
    if (splitType === "ratio") {
      const invalid = item.assignments.some((a) => !isValidRatioPart(a.ratio ?? 0));
      if (invalid) {
        ctx.addIssue({
          code: "custom",
          path: ["assignments"],
          message: `"${item.name}": ratio parts must be positive whole numbers.`,
        });
      }
    }
  });

function formatPaiseForMessage(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

export const createBillSchema = insertBillSchema.extend({
  groupId: z.number().int().positive(),
  items: z.array(billItemInputSchema).min(1, "Add at least one item"),
});

export const updateBillSchema = createBillSchema.partial().extend({
  groupId: z.number().int().positive(),
});

export const selectBillSchema = createSelectSchema(bills);
export const selectBillItemSchema = createSelectSchema(billItems);
export const selectItemAssignmentSchema = createSelectSchema(itemAssignments);
export const selectSettlementSchema = createSelectSchema(settlements);

export type ItemAssignmentInput = z.infer<typeof itemAssignmentInputSchema>;
export type BillItemInput = z.infer<typeof billItemInputSchema>;

export type User = z.infer<typeof selectUserSchema>;
export type Group = z.infer<typeof selectGroupSchema>;
export type GroupMember = z.infer<typeof selectGroupMemberSchema>;
export type Bill = z.infer<typeof selectBillSchema>;
export type BillItem = z.infer<typeof selectBillItemSchema>;
export type ItemAssignment = z.infer<typeof selectItemAssignmentSchema>;
export type Settlement = z.infer<typeof selectSettlementSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type CreateBillInput = z.infer<typeof createBillSchema>;
export type UpdateBillInput = z.infer<typeof updateBillSchema>;
