import {
  pgTable,
  integer,
  bigint,
  bigserial,
  text,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./schema.js";

// ---------------------------------------------------------------------------
// Infrastructure tables for the Pi-primary / Supabase-standby setup (see
// PLAN-PI-PRODUCTIONIZATION.md workstream S). Kept in their own file so the
// product schema in schema.ts stays free of ops concerns. None of these are
// part of the API surface.
// ---------------------------------------------------------------------------

export const IDEMPOTENCY_STATUSES = ["in_progress", "completed"] as const;

/**
 * Idempotency-Key store (plan S6.1). One row per (user, key). A row is
 * claimed atomically with INSERT ... ON CONFLICT before the handler runs
 * (status "in_progress") and completed with the stored response once the
 * handler has answered 2xx. Rows older than 24 h are dead and are replaced
 * or swept lazily — see server/src/middleware/idempotency.ts.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    // sha256 of method + path(+query) + canonical body
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: IDEMPOTENCY_STATUSES }).notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.key] }),
    index("idempotency_keys_created_at_idx").on(table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Two-sided write safety (plan S5). The per-row columns `updated_at` and
// `origin` that migration 0005 adds to every synced table are DB-managed
// (BEFORE INSERT/UPDATE trigger) and deliberately NOT declared on the product
// tables in schema.ts — undeclared columns can never leak into an API
// response (Drizzle only selects/returns declared columns), and `Group`/
// `Bill` etc. keep their client-visible shape.
// ---------------------------------------------------------------------------

export const NODE_ORIGINS = ["pi", "standby"] as const;
export type NodeOrigin = (typeof NODE_ORIGINS)[number];

/**
 * Tables replicated between nodes, parents before children (FK dependency
 * order). Apply upserts in this order and deletes in reverse. Whenever a
 * table is added to the product schema it must be added here AND get the
 * 0005 triggers (plan §9 dependency note).
 */
export const SYNCED_TABLES = [
  "users",
  "groups",
  "group_members",
  "bills",
  "bill_items",
  "item_assignments",
  "settlements",
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

/** Rows deleted on a node, written by an AFTER DELETE trigger (not soft-delete). */
export const deletionLog = pgTable(
  "deletion_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tableName: text("table_name").notNull(),
    pk: bigint("pk", { mode: "number" }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    origin: text("origin", { enum: NODE_ORIGINS }).notNull().default("pi"),
  },
  (table) => [
    index("deletion_log_table_pk_idx").on(table.tableName, table.pk),
    index("deletion_log_deleted_at_idx").on(table.deletedAt),
  ],
);

/**
 * Rows changed on both sides since the last sync. Resolved last-writer-wins
 * by updated_at; the loser is kept here, in full, for owner review.
 */
export const syncConflicts = pgTable(
  "sync_conflicts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tableName: text("table_name").notNull(),
    pk: bigint("pk", { mode: "number" }).notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    winnerOrigin: text("winner_origin", { enum: NODE_ORIGINS }).notNull(),
    winnerUpdatedAt: timestamp("winner_updated_at", { withTimezone: true }),
    loserUpdatedAt: timestamp("loser_updated_at", { withTimezone: true }),
    winnerRow: jsonb("winner_row"),
    loserRow: jsonb("loser_row"),
    note: text("note"),
  },
  (table) => [index("sync_conflicts_detected_at_idx").on(table.detectedAt)],
);
