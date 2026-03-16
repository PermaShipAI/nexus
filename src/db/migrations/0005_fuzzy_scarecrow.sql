ALTER TABLE "pending_actions" ADD COLUMN "original_action_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "strategy_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_strategy_idx" ON "tasks" ("strategy_id");