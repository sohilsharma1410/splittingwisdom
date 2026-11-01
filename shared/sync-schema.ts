import {
  pgTable,
  integer,
  bigint,
  bigserial,
  doublePrecision,
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

export const OUTBOX_OPS = ["upsert", "delete"] as const;

/**
 * Durable change feed (plan S2.2), appended to by AFTER row triggers on every
 * synced table. `payload` is the full row image (to_jsonb(NEW)) at that
 * moment, so replaying events in id order reproduces history and is
 * FK-safe by construction. Shipped rows get `sent_at`; the agent picks
 * `sent_at IS NULL` rather than a cursor because ids are assigned at trigger
 * time but become visible at commit time (a lower id can commit later).
 */
export const syncOutbox = pgTable(
  "sync_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tableName: text("table_name").notNull(),
    pk: bigint("pk", { mode: "number" }).notNull(),
    op: text("op", { enum: OUTBOX_OPS }).notNull(),
    // Top-level transaction id: the agent only ships whole transactions
    // (a closed prefix), so a batch never contains half of a cascade.
    xid: bigint("xid", { mode: "number" }).notNull().default(sql`txid_current()`),
    payload: jsonb("payload"),
    at: timestamp("at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    index("sync_outbox_unsent_idx").on(table.id).where(sql`${table.sentAt} IS NULL`),
    index("sync_outbox_sent_at_idx").on(table.sentAt).where(sql`${table.sentAt} IS NOT NULL`),
  ],
);

export const ACTIVE_PRIMARIES = ["pi", "standby", "cutover"] as const;
export type ActivePrimary = (typeof ACTIVE_PRIMARIES)[number];

/**
 * Who may write right now (plan S3.1). One row, authoritative in the
 * always-reachable standby database (Supabase). `cutover` = failback in
 * progress: nobody writes. `epoch` increases on every transition and is the
 * fencing token.
 */
export const systemState = pgTable("system_state", {
  id: integer("id").primaryKey().default(1),
  activePrimary: text("active_primary", { enum: ACTIVE_PRIMARIES }).notNull().default("pi"),
  epoch: integer("epoch").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Liveness written by the Pi's API process into the standby DB every ~15 s
 * (plan S3.5), carrying its sync position so the standby can report it.
 * Failover requires BOTH this to go stale AND the HTTP probe to fail.
 */
export const nodeHeartbeat = pgTable("node_heartbeat", {
  node: text("node", { enum: NODE_ORIGINS }).primaryKey(),
  beatAt: timestamp("beat_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lagSeconds: doublePrecision("lag_seconds"),
});

/** Single-row heartbeat the sync agent writes; read by GET /api/health/role. */
export const syncStatus = pgTable("sync_status", {
  id: integer("id").primaryKey().default(1),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
