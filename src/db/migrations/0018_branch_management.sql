ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "execution_branch" text;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "merge_status" text;
