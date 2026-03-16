CREATE TABLE IF NOT EXISTS "codebase_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"repo_key" text NOT NULL,
	"latest_commit_sha" text,
	"commit_frequency" real,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "file_context" jsonb;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "last_staleness_check_at" timestamp;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "staleness_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "codebase_snapshot_org_repo_idx" ON "codebase_snapshots" ("org_id","repo_key");