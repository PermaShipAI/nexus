-- Phase 1: Per-project policy and project-level tracking
ALTER TABLE local_projects ADD COLUMN IF NOT EXISTS policy JSONB;
--> statement-breakpoint
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS project_id UUID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pending_action_project_idx ON pending_actions(project_id);
--> statement-breakpoint
-- Backfill project_id from args->>'project-id' where possible
UPDATE pending_actions
SET project_id = (args->>'project-id')::uuid
WHERE project_id IS NULL
  AND args->>'project-id' IS NOT NULL
  AND args->>'project-id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
