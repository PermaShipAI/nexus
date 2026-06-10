import type { AgentId } from '../../agents/types.js';

export interface CreateSuggestionInput {
  repoKey: string;
  title: string;
  kind: 'bug' | 'feature' | 'task';
  description: string;
  projectId: string;
  priority?: number;
  labels?: string[];
}

export interface CreateTicketInput {
  orgId: string;
  kind: 'bug' | 'feature' | 'task';
  title: string;
  description: string;
  repoKey: string;
  projectId: string;
  priority?: number;
  labels?: string[];
  createdByAgentId: AgentId;
  /**
   * When true, instructs the Conductor to halt before pushing the branch.
   * MUST be set to true for any ticket involving "Nexus DoD", security guardrails,
   * or mandatory CISO/UX review gates to prevent invalid state machine transitions
   * from waiting_for_human to ci_running.
   */
  skipPush?: boolean;
}

export interface Suggestion {
  id: string;
  orgId: string;
  projectId: string;
  repoKey: string;
  title: string;
  kind: 'bug' | 'feature' | 'task';
  description: string;
  affectedFiles: string[];
  status: 'pending' | 'accepted' | 'dismissed' | 'superseded';
  createdAt: string;
  updatedAt: string;
}

/** @deprecated Use `Suggestion` instead */
export type PermashipSuggestion = Suggestion;

export interface TicketTracker {
  createSuggestion(
    orgId: string,
    input: CreateSuggestionInput,
  ): Promise<{ success: boolean; suggestionId?: string; error?: string }>;

  acceptSuggestion(
    orgId: string,
    projectId: string,
    suggestionId: string,
  ): Promise<{ success: boolean; ticketId?: string; status?: string; error?: string }>;

  dismissSuggestion(
    orgId: string,
    projectId: string,
    suggestionId: string,
  ): Promise<{ success: boolean; error?: string }>;

  createTicket(
    input: CreateTicketInput,
  ): Promise<{ success: boolean; ticketId?: string; error?: string }>;

  listSuggestions(
    orgId: string,
    projectId: string,
    params?: { status?: string; repoKey?: string },
  ): Promise<Suggestion[]>;
}
