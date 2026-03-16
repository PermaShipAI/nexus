import {
  createSuggestion,
  acceptSuggestion,
  dismissSuggestion,
  createPermashipTicket,
  listSuggestions,
} from '../../permaship/client.js';
import type {
  TicketTracker,
  CreateSuggestionInput,
  CreateTicketInput,
  PermashipSuggestion,
} from '../interfaces/ticket-tracker.js';

export class PermashipTicketTracker implements TicketTracker {
  async createSuggestion(
    orgId: string,
    input: CreateSuggestionInput,
  ): Promise<{ success: boolean; suggestionId?: string; error?: string }> {
    return createSuggestion(orgId, input);
  }

  async acceptSuggestion(
    orgId: string,
    projectId: string,
    suggestionId: string,
  ): Promise<{ success: boolean; ticketId?: string; status?: string; error?: string }> {
    return acceptSuggestion(orgId, projectId, suggestionId);
  }

  async dismissSuggestion(
    orgId: string,
    projectId: string,
    suggestionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    return dismissSuggestion(orgId, projectId, suggestionId);
  }

  async createTicket(
    input: CreateTicketInput,
  ): Promise<{ success: boolean; ticketId?: string; error?: string }> {
    return createPermashipTicket(input);
  }

  async listSuggestions(
    orgId: string,
    projectId: string,
    params?: { status?: string; repoKey?: string },
  ): Promise<PermashipSuggestion[]> {
    return listSuggestions(orgId, projectId, params);
  }
}
