-- Rename permaship_tickets table to tickets
ALTER TABLE IF EXISTS "permaship_tickets" RENAME TO "tickets";--> statement-breakpoint

-- Rename indexes
ALTER INDEX IF EXISTS "permaship_ticket_org_idx" RENAME TO "ticket_org_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "permaship_ticket_agent_idx" RENAME TO "ticket_agent_idx";--> statement-breakpoint

-- Rename foreign key constraint
ALTER TABLE "tickets" RENAME CONSTRAINT "permaship_tickets_created_by_agent_id_agents_id_fk" TO "tickets_created_by_agent_id_agents_id_fk";
