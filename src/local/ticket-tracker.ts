import { randomUUID } from 'crypto';
import { db } from '../db/index.js';
import { permashipTickets } from '../db/schema.js';
import { logger } from '../logger.js';
import type {
  TicketTracker,
  CreateSuggestionInput,
  CreateTicketInput,
  PermashipSuggestion,
} from '../adapters/interfaces/ticket-tracker.js';

/**
 * Local-only TicketTracker that stores everything in the local database.
 * No remote API calls — suggestions and tickets live entirely in Postgres.
 */
export class LocalTicketTracker implements TicketTracker {
  /** In-memory suggestion store (local-only, no remote API) */
  private suggestions = new Map<string, PermashipSuggestion>();

  async createSuggestion(
    orgId: string,
    input: CreateSuggestionInput,
  ): Promise<{ success: boolean; suggestionId?: string; error?: string }> {
    const id = randomUUID();
    const suggestion: PermashipSuggestion = {
      id,
      orgId,
      projectId: input.projectId,
      repoKey: input.repoKey,
      title: input.title,
      kind: input.kind,
      description: input.description,
      affectedFiles: [],
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.suggestions.set(id, suggestion);
    logger.info({ suggestionId: id, title: input.title }, 'Local suggestion created');
    return { success: true, suggestionId: id };
  }

  async acceptSuggestion(
    orgId: string,
    _projectId: string,
    suggestionId: string,
  ): Promise<{ success: boolean; ticketId?: string; status?: string; error?: string }> {
    const suggestion = this.suggestions.get(suggestionId);
    if (suggestion) {
      suggestion.status = 'accepted';
      suggestion.updatedAt = new Date().toISOString();
    }
    const ticketId = randomUUID();
    logger.info({ suggestionId, ticketId }, 'Local suggestion accepted');
    return { success: true, ticketId, status: 'accepted' };
  }

  async dismissSuggestion(
    _orgId: string,
    _projectId: string,
    suggestionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const suggestion = this.suggestions.get(suggestionId);
    if (suggestion) {
      suggestion.status = 'dismissed';
      suggestion.updatedAt = new Date().toISOString();
    }
    logger.info({ suggestionId }, 'Local suggestion dismissed');
    return { success: true };
  }

  async createTicket(
    input: CreateTicketInput,
  ): Promise<{ success: boolean; ticketId?: string; error?: string }> {
    try {
      const [ticket] = await db.insert(permashipTickets).values({
        orgId: input.orgId,
        kind: input.kind,
        title: input.title,
        description: input.description,
        repoKey: input.repoKey,
        priority: input.priority ?? 3,
        labels: input.labels ?? [],
        createdByAgentId: input.createdByAgentId,
      }).returning();

      logger.info({ ticketId: ticket.id, title: input.title }, 'Local ticket created');
      return { success: true, ticketId: ticket.id };
    } catch (err) {
      logger.error({ err }, 'Failed to create local ticket');
      return { success: false, error: (err as Error).message };
    }
  }

  async listSuggestions(
    orgId: string,
    _projectId: string,
    params?: { status?: string; repoKey?: string },
  ): Promise<PermashipSuggestion[]> {
    return Array.from(this.suggestions.values()).filter(s => {
      if (s.orgId !== orgId) return false;
      if (params?.status && s.status !== params.status) return false;
      if (params?.repoKey && s.repoKey !== params.repoKey) return false;
      return true;
    });
  }
}
