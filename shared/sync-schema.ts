import {
  pgTable,
  integer,
  text,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
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
