CREATE TABLE IF NOT EXISTS "public_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"registered_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"workspace_id" text NOT NULL,
	"activated_at" timestamp DEFAULT now() NOT NULL,
	"activated_by" text NOT NULL,
	"internal_channel_id" text
);
--> statement-breakpoint
ALTER TABLE "bot_settings" DROP CONSTRAINT "bot_settings_key_unique";--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_settings" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_history" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "idle_suggestions" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "permaship_tickets" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_channel_org_idx" ON "public_channels" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_channel_id_idx" ON "public_channels" ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ws_link_org_idx" ON "workspace_links" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ws_link_workspace_idx" ON "workspace_links" ("platform","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_org_idx" ON "activity_log" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_settings_org_idx" ON "bot_settings" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_org_idx" ON "conversation_history" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idle_suggestion_org_idx" ON "idle_suggestions" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_org_idx" ON "knowledge_entries" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_action_org_idx" ON "pending_actions" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permaship_ticket_org_idx" ON "permaship_tickets" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_org_idx" ON "secrets" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_org_idx" ON "tasks" ("org_id");