-- 0007_system_state — roles and fencing (plan S3).
--
-- system_state: the single authoritative "who may write" record. Only the copy
-- in the standby (Supabase) database is authoritative; the Pi's copy is inert.
-- node_heartbeat: liveness the Pi's API writes into the standby database.
-- Seeded 'pi' / epoch 1: until a controller says otherwise the Pi is primary.

CREATE TABLE "node_heartbeat" (
	"node" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"lag_seconds" double precision
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"active_primary" text DEFAULT 'pi' NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_heartbeat" ADD CONSTRAINT "node_heartbeat_node_check" CHECK ("node" IN ('pi', 'standby'));--> statement-breakpoint
ALTER TABLE "system_state" ADD CONSTRAINT "system_state_singleton" CHECK ("id" = 1);--> statement-breakpoint
ALTER TABLE "system_state" ADD CONSTRAINT "system_state_active_primary_check" CHECK ("active_primary" IN ('pi', 'standby', 'cutover'));--> statement-breakpoint
INSERT INTO "system_state" ("id", "active_primary", "epoch") VALUES (1, 'pi', 1);
