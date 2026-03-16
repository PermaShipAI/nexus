ALTER TABLE "knowledge_entries" ADD COLUMN "source_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_source_idx" ON "knowledge_entries" ("source_id");