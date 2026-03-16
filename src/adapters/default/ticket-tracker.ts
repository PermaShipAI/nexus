import { randomUUID } from 'node:crypto';
import type {
  TicketTracker,
  CreateSuggestionInput,
  CreateTicketInput,
  PermashipSuggestion,
} from '../interfaces/ticket-tracker.js';

interface StoredSuggestion extends PermashipSuggestion {
  priority?: number;
  labels?: string[];
}

/**
 * In-memory ticket tracker for standalone/development use.
 * Stores suggestions and tickets locally without calling any external API.
 */
export class LocalTicketTracker implements TicketTracker {
  private suggestions: Map<string, StoredSuggestion> = new Map();

  async createSuggestion(
    orgId: string,
    input: CreateSuggestionInput,
  ): Promise<{ success: boolean; suggestionId?: string; error?: string }> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.suggestions.set(id, {
      id,
      orgId,
      projectId: input.projectId,
      repoKey: input.repoKey,
      title: input.title,
      kind: input.kind,
      description: input.description,
      affectedFiles: [],
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      priority: input.priority,
      labels: input.labels,
    });
    return { success: true, suggestionId: id };
  }

  async acceptSuggestion(
    _orgId: string,
    _projectId: string,
    suggestionId: string,
  ): Promise<{ success: boolean; ticketId?: string; status?: string; error?: string }> {
    const suggestion = this.suggestions.get(suggestionId);
    if (!suggestion) return { success: false, error: 'Suggestion not found' };
    suggestion.status = 'accepted';
    suggestion.updatedAt = new Date().toISOString();
    const ticketId = randomUUID();
    return { success: true, ticketId, status: 'accepted' };
  }

  async dismissSuggestion(
    _orgId: string,
    _projectId: string,
    suggestionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const suggestion = this.suggestions.get(suggestionId);
    if (!suggestion) return { success: false, error: 'Suggestion not found' };
    suggestion.status = 'dismissed';
    suggestion.updatedAt = new Date().toISOString();
    return { success: true };
  }

  async createTicket(
    _input: CreateTicketInput,
  ): Promise<{ success: boolean; ticketId?: string; error?: string }> {
    return { success: true, ticketId: randomUUID() };
  }

  async listSuggestions(
    orgId: string,
    projectId: string,
    params?: { status?: string; repoKey?: string },
  ): Promise<PermashipSuggestion[]> {
    return Array.from(this.suggestions.values()).filter((s) => {
      if (s.orgId !== orgId) return false;
      if (s.projectId !== projectId) return false;
      if (params?.status && s.status !== params.status) return false;
      if (params?.repoKey && s.repoKey !== params.repoKey) return false;
      return true;
    });
  }
}
