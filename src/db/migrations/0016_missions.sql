DO $$ BEGIN
  CREATE TYPE "mission_status" AS ENUM ('draft', 'planning', 'active', 'paused', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "missions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "channel_id" text NOT NULL UNIQUE,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "status" "mission_status" NOT NULL DEFAULT 'draft',
  "heartbeat_interval_ms" integer NOT NULL DEFAULT 600000,
  "last_heartbeat_at" timestamp,
  "next_heartbeat_at" timestamp,
  "cron_expression" text,
  "recurring_parent_id" uuid,
  "completed_at" timestamp,
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_org_idx" ON "missions" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_status_idx" ON "missions" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_next_heartbeat_idx" ON "missions" ("next_heartbeat_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mission_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "assigned_agent_id" text,
  "completed_by_agent_id" text,
  "verified_at" timestamp,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_item_mission_idx" ON "mission_items" ("mission_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mission_id" uuid NOT NULL,
  "project_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_project_mission_idx" ON "mission_projects" ("mission_id");
