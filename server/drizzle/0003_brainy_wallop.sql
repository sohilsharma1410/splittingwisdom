ALTER TABLE "item_assignments" DROP CONSTRAINT "item_assignments_member_id_group_members_id_fk";
--> statement-breakpoint
ALTER TABLE "item_assignments" ADD CONSTRAINT "item_assignments_member_id_group_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."group_members"("id") ON DELETE no action ON UPDATE no action;