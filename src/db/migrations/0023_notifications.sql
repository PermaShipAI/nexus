CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'info',
  "read" boolean NOT NULL DEFAULT false,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_org_idx" ON "notifications" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_read_idx" ON "notifications" ("org_id", "read");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_created_at_idx" ON "notifications" ("created_at");
