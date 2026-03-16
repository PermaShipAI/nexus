DO $$ BEGIN
 CREATE TYPE "public"."knowledge_kind" AS ENUM('shared', 'agent_memory');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."task_priority" AS ENUM('critical', 'high', 'medium', 'low');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."task_status" AS ENUM('proposed', 'approved', 'in_progress', 'completed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ticket_kind" AS ENUM('bug', 'feature', 'task');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"agent_id" text,
	"channel_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"persona_md" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"discord_message_id" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"content" text NOT NULL,
	"is_agent" boolean DEFAULT false NOT NULL,
	"agent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "knowledge_kind" NOT NULL,
	"agent_id" text,
	"topic" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permaship_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remote_ticket_id" text,
	"kind" "ticket_kind" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"repo_key" text NOT NULL,
	"priority" integer DEFAULT 3,
	"labels" jsonb DEFAULT '[]'::jsonb,
	"created_by_agent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "task_status" DEFAULT 'proposed' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"assigned_agent_id" text,
	"proposed_by_agent_id" text,
	"discord_message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation_history" ADD CONSTRAINT "conversation_history_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "permaship_tickets" ADD CONSTRAINT "permaship_tickets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_created_at_idx" ON "activity_log" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_channel_idx" ON "conversation_history" ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_channel_created_idx" ON "conversation_history" ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_kind_agent_idx" ON "knowledge_entries" ("kind","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_topic_idx" ON "knowledge_entries" ("topic");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permaship_ticket_agent_idx" ON "permaship_tickets" ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_status_idx" ON "tasks" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_assigned_idx" ON "tasks" ("assigned_agent_id");