CREATE TABLE IF NOT EXISTS "bot_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bot_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_settings_key_idx" ON "bot_settings" ("key");