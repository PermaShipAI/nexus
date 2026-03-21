ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "autonomous_mode" boolean;
--> statement-breakpoint
ALTER TABLE "local_projects" ADD COLUMN IF NOT EXISTS "autonomous_mode" boolean;
