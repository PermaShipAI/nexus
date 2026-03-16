ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "execution_status" text DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "execution_backend" text;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "execution_output" text;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "execution_diff" text;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "execution_review" text;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "executed_at" timestamp;

