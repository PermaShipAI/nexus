ALTER TABLE "mission_items" ADD COLUMN IF NOT EXISTS "parent_id" uuid;
--> statement-breakpoint
ALTER TABLE "mission_items" ADD COLUMN IF NOT EXISTS "is_phase" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "mission_items" SET "is_phase" = true WHERE "parent_id" IS NULL;
