CREATE TABLE IF NOT EXISTS "mission_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mission_id" uuid NOT NULL,
  "agent_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_agent_mission_idx" ON "mission_agents" ("mission_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_agent_agent_idx" ON "mission_agents" ("agent_id");
