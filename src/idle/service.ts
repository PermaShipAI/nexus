import { eq, and, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { idleSuggestions, type NewIdleSuggestion, type IdleSuggestion } from '../db/schema.js';
import { logger } from '../logger.js';

export async function queueSuggestion(suggestion: NewIdleSuggestion): Promise<IdleSuggestion> {
  const [inserted] = await db.insert(idleSuggestions).values(suggestion).returning();
  logger.info({ suggestionId: inserted.id, agentId: inserted.agentId, orgId: inserted.orgId }, 'Queued new idle suggestion');
  return inserted;
}

export async function getQueuedSuggestions(orgId: string): Promise<IdleSuggestion[]> {
  return db
    .select()
    .from(idleSuggestions)
    .where(and(eq(idleSuggestions.status, 'queued'), eq(idleSuggestions.orgId, orgId)))
    .orderBy(asc(idleSuggestions.createdAt));
}

export async function markSuggestionsAsSent(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    await db.update(idleSuggestions).set({ status: 'sent', sentAt: new Date() }).where(eq(idleSuggestions.id, id));
  }
}

export async function getSuggestionById(id: string, orgId: string): Promise<IdleSuggestion | undefined> {
    const [suggestion] = await db.select().from(idleSuggestions).where(and(eq(idleSuggestions.id, id), eq(idleSuggestions.orgId, orgId))).limit(1);
    return suggestion;
}
