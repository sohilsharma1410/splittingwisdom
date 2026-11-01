-- 0005_sync_safety — schema for safe two-sided writes (plan S5.2-S5.5).
--
-- Adds, for every synced table (users, groups, group_members, bills,
-- bill_items, item_assignments, settlements):
--   * updated_at timestamptz  - bumped by trigger on every write
--   * origin text             - 'pi' | 'standby': the node that last wrote the row
--   * AFTER DELETE trigger    - appends to deletion_log (no soft-delete, so no
--                               existing query changes)
-- plus deletion_log, sync_conflicts, and helper functions.
--
-- Sync-apply escape hatch: a sync agent / reverse-sync transaction runs
--   SELECT set_config('sw.sync_apply', 'on', true);
-- first. While it is on, the triggers keep the incoming updated_at/origin
-- verbatim and write NO deletion_log row (otherwise replicated rows would be
-- restamped and bounce back and forth).
--
-- NOT applied here: the standby ID range / origin tag. That is an explicit
-- per-node step, run once on the standby only:
--   SELECT sw_configure_standby_node();      -- see function below
--
-- Each statement is separated by a drizzle statement-breakpoint marker.

CREATE TABLE "deletion_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"pk" bigint NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"origin" text DEFAULT 'pi' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_conflicts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"pk" bigint NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"winner_origin" text NOT NULL,
	"winner_updated_at" timestamp with time zone,
	"loser_updated_at" timestamp with time zone,
	"winner_row" jsonb,
	"loser_row" jsonb,
	"note" text
);
--> statement-breakpoint
CREATE INDEX "deletion_log_table_pk_idx" ON "deletion_log" USING btree ("table_name","pk");--> statement-breakpoint
CREATE INDEX "deletion_log_deleted_at_idx" ON "deletion_log" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "sync_conflicts_detected_at_idx" ON "sync_conflicts" USING btree ("detected_at");--> statement-breakpoint
ALTER TABLE "deletion_log" ADD CONSTRAINT "deletion_log_origin_check" CHECK ("origin" IN ('pi', 'standby'));--> statement-breakpoint
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_winner_origin_check" CHECK ("winner_origin" IN ('pi', 'standby'));--> statement-breakpoint

-- groups/bills already had updated_at as `timestamp` (no zone). Existing
-- values were written as UTC (app: new Date() -> ISO string; DB default:
-- Supabase session TimeZone is UTC), so reinterpret them explicitly as UTC —
-- a bare SET DATA TYPE would use the *session* zone instead.
ALTER TABLE "bills" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "bills" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "group_members" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "item_assignments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "origin" text DEFAULT 'pi' NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "origin" text DEFAULT 'pi' NOT NULL;--> statement-breakpoint
ALTER TABLE "group_members" ADD COLUMN "origin" text DEFAULT 'pi' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "origin" text DEFAULT 'pi' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "origin" text DEFAULT 'pi' NOT NULL;--> statement-breakpoint
ALTER TABLE "item_assignments" ADD COLUMN "origin" text DEFAULT 'pi' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "origin" text DEFAULT 'pi' NOT NULL;--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_origin_check" CHECK ("origin" IN ('pi', 'standby'));--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_origin_check" CHECK ("origin" IN ('pi', 'standby'));--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_origin_check" CHECK ("origin" IN ('pi', 'standby'));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_origin_check" CHECK ("origin" IN ('pi', 'standby'));--> statement-breakpoint
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_origin_check" CHECK ("origin" IN ('pi', 'standby'));--> statement-breakpoint
ALTER TABLE "item_assignments" ADD CONSTRAINT "item_assignments_origin_check" CHECK ("origin" IN ('pi', 'standby'));--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_origin_check" CHECK ("origin" IN ('pi', 'standby'));--> statement-breakpoint

-- True while a sync/failback transaction is applying replicated data.
CREATE OR REPLACE FUNCTION sw_sync_applying() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('sw.sync_apply', true), '') = 'on'
$$;--> statement-breakpoint

-- Which node this database is: 'pi' unless `ALTER DATABASE ... SET sw.origin =
-- 'standby'` was run (sw_configure_standby_node does exactly that). A database
-- level setting survives pooling and restarts and is NOT carried by pg_dump
-- --data-only, so a Pi restore of the standby's data can't flip the Pi's role.
CREATE OR REPLACE FUNCTION sw_node_origin() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN current_setting('sw.origin', true) = 'standby' THEN 'standby' ELSE 'pi' END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION sw_touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF sw_sync_applying() THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := clock_timestamp();
  NEW.origin := sw_node_origin();
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION sw_log_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT sw_sync_applying() THEN
    INSERT INTO deletion_log (table_name, pk, origin)
    VALUES (TG_TABLE_NAME, OLD.id, sw_node_origin());
  END IF;
  RETURN OLD;
END
$$;--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','groups','group_members','bills','bill_items','item_assignments','settlements']
  LOOP
    EXECUTE format('CREATE TRIGGER sw_touch BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION sw_touch_row()', t);
    EXECUTE format('CREATE TRIGGER sw_log_delete AFTER DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sw_log_delete()', t);
  END LOOP;
END
$$;--> statement-breakpoint

-- Moves every id sequence of the synced tables up to `floor_value` (never
-- down). The first id handed out afterwards is exactly `floor_value`.
-- Idempotent. Returns one row per sequence with the id it will hand out next.
CREATE OR REPLACE FUNCTION sw_set_sequence_floor(floor_value bigint DEFAULT 1000000000)
RETURNS TABLE (sequence_name text, next_value bigint)
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  cur bigint;
BEGIN
  FOR r IN
    SELECT format('%I.%I', sn.nspname, s.relname) AS seq
    FROM pg_class s
    JOIN pg_namespace sn ON sn.oid = s.relnamespace
    JOIN pg_depend d ON d.objid = s.oid
                    AND d.classid = 'pg_class'::regclass
                    AND d.refclassid = 'pg_class'::regclass
                    AND d.deptype IN ('a', 'i')
    JOIN pg_class t ON t.oid = d.refobjid
    WHERE s.relkind = 'S'
      AND sn.nspname = 'public'
      AND t.relname IN ('users','groups','group_members','bills','bill_items','item_assignments','settlements')
    ORDER BY 1
  LOOP
    EXECUTE format('SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM %s', r.seq) INTO cur;
    IF cur < floor_value THEN
      PERFORM setval(r.seq, floor_value, false);
      cur := floor_value;
    END IF;
    sequence_name := r.seq;
    next_value := cur;
    RETURN NEXT;
  END LOOP;
END
$$;--> statement-breakpoint

-- EXPLICIT PER-NODE STEP — run ONLY on the standby database (plan S5.1),
-- never as part of a default migration:
--   SELECT * FROM sw_configure_standby_node();
-- 1. moves the id sequences to the standby range (>= 1_000_000_000) so ids
--    created during an outage can never collide with the Pi's;
-- 2. tags this database as origin 'standby' (database-level setting; takes
--    effect for NEW connections - restart/recycle the standby API pool).
-- To undo the origin tag (not the sequences): SELECT sw_reset_node_origin();
CREATE OR REPLACE FUNCTION sw_configure_standby_node(floor_value bigint DEFAULT 1000000000)
RETURNS TABLE (sequence_name text, next_value bigint)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET sw.origin TO %L', current_database(), 'standby');
  RETURN QUERY SELECT * FROM sw_set_sequence_floor(floor_value);
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION sw_reset_node_origin() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER DATABASE %I RESET sw.origin', current_database());
END
$$;
