CREATE TABLE IF NOT EXISTS "adr_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "failure_class" text NOT NULL,
  "evidence_action_ids" jsonb NOT NULL DEFAULT '[]',
  "status" text NOT NULL DEFAULT 'pending_review',
  "committed_path" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adr_draft_org_idx" ON "adr_drafts" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adr_draft_status_idx" ON "adr_drafts" ("status");
