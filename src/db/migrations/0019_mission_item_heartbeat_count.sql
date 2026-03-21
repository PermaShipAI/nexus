ALTER TABLE "mission_items" ADD COLUMN IF NOT EXISTS "heartbeat_count" integer NOT NULL DEFAULT 0;
