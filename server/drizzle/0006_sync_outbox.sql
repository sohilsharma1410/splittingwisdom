-- 0006_sync_outbox — change feed for the forward sync agent (plan S2.2).
--
-- sync_outbox is appended to by an AFTER row trigger on every synced table,
-- in the same transaction as the change. `xid` lets the agent ship whole
-- transactions only. sync_status is the agent's heartbeat row.
-- The last statement makes the synced tables' FKs/uniques DEFERRABLE so the
-- agent can apply a batch in one transaction without ordering gymnastics.

CREATE TABLE "sync_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"pk" bigint NOT NULL,
	"op" text NOT NULL,
	"xid" bigint DEFAULT txid_current() NOT NULL,
	"payload" jsonb,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_status" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sync_outbox_unsent_idx" ON "sync_outbox" USING btree ("id") WHERE "sync_outbox"."sent_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sync_outbox_sent_at_idx" ON "sync_outbox" USING btree ("sent_at") WHERE "sync_outbox"."sent_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_op_check" CHECK ("op" IN ('upsert', 'delete'));--> statement-breakpoint
ALTER TABLE "sync_status" ADD CONSTRAINT "sync_status_singleton" CHECK ("id" = 1);--> statement-breakpoint
INSERT INTO "sync_status" ("id") VALUES (1);--> statement-breakpoint

-- 0006_sync_outbox — change feed for the forward sync agent (plan S2.2).
-- Row image is captured AFTER the sw_touch BEFORE trigger has stamped
-- updated_at/origin, so it carries the final values. Skipped while a sync
-- transaction is applying replicated data (sw.sync_apply = on), which is what
-- keeps the standby from echoing replicated rows back.
CREATE OR REPLACE FUNCTION sw_enqueue_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF sw_sync_applying() THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    INSERT INTO sync_outbox (table_name, pk, op) VALUES (TG_TABLE_NAME, OLD.id, 'delete');
  ELSE
    INSERT INTO sync_outbox (table_name, pk, op, payload) VALUES (TG_TABLE_NAME, NEW.id, 'upsert', to_jsonb(NEW));
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','groups','group_members','bills','bill_items','item_assignments','settlements']
  LOOP
    EXECUTE format('CREATE TRIGGER sw_outbox AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sw_enqueue_outbox()', t);
  END LOOP;
END
$$;--> statement-breakpoint

-- Make every foreign key and unique constraint of the synced tables
-- DEFERRABLE INITIALLY IMMEDIATE. Application behaviour is unchanged (checks
-- still happen at the end of each statement), but the sync agent can run
-- `SET CONSTRAINTS ALL DEFERRED` and apply a batch of changes in any order,
-- re-apply a batch after a crash, and still be checked once at COMMIT. Without
-- this a replayed batch can trip over transient intermediate states, e.g.
-- "member removed, same user re-added" (unique (group_id, user_id)) and then
-- retry that failure forever. Primary keys stay immediate (they are the
-- ON CONFLICT arbiters).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conrelid::regclass AS tbl, con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public'
      AND cl.relname IN ('users','groups','group_members','bills','bill_items','item_assignments','settlements')
      AND con.contype IN ('f', 'u')
      AND NOT con.condeferrable
  LOOP
    IF c.contype = 'f' THEN
      EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', c.tbl, c.conname);
    ELSE
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s DEFERRABLE INITIALLY IMMEDIATE', c.tbl, c.conname, c.def);
    END IF;
  END LOOP;
END
$$;