-- ============================================================================
-- ROLLBACK for migration 0013: Undo the permaship_tickets → tickets rename
--
-- Run this manually against the database if the rename causes problems:
--   psql "$DATABASE_URL" -f rollback-migration-0013.sql
--
-- After running this, you must also:
--   1. Roll back the ECS service to the previous task definition (./rollback.sh)
--   2. Delete the drizzle migration journal entry:
--      DELETE FROM "__drizzle_migrations" WHERE hash = '<hash-of-0013>';
-- ============================================================================

ALTER TABLE "tickets" RENAME TO "permaship_tickets";

ALTER INDEX "ticket_org_idx" RENAME TO "permaship_ticket_org_idx";

ALTER INDEX "ticket_agent_idx" RENAME TO "permaship_ticket_agent_idx";

ALTER TABLE "permaship_tickets" RENAME CONSTRAINT "tickets_created_by_agent_id_agents_id_fk" TO "permaship_tickets_created_by_agent_id_agents_id_fk";
