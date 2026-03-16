CREATE TABLE IF NOT EXISTS "local_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "source_type" text NOT NULL,
  "local_path" text NOT NULL,
  "remote_url" text,
  "repo_key" text NOT NULL,
  "clone_status" text NOT NULL DEFAULT 'ready',
  "clone_error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_project_org_idx" ON "local_projects" ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "local_project_slug_org_idx" ON "local_projects" ("slug", "org_id");

