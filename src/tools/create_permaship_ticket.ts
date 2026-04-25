import { AgentId } from '../agents/types.js';
import { logger } from '../logger.js';

export interface CreatePermashipTicketInput {
  orgId: string;
  kind: 'bug' | 'feature' | 'task';
  title: string;
  description: string;
  agentId: AgentId;
  priority?: number;
}

export interface CreatePermashipTicketResult {
  success: boolean;
  message: string;
  ticketId?: string;
}

export async function createPermashipTicket(input: CreatePermashipTicketInput): Promise<CreatePermashipTicketResult> {
  const { orgId, kind, title, description, agentId, priority } = input;
  const APP_API_URL = process.env.APP_API_URL;
  const APP_API_KEY = process.env.APP_API_KEY;

  if (!APP_API_URL) {
    logger.warn({ event: 'agent.tool.conductor_url_missing', success: false });
    return { success: false, message: 'APP_API_URL is not configured. Please ask the user to verify the orchestrator URL and try again.' };
  }

  try {
    const response = await fetch(`${APP_API_URL}/api/orgs/${orgId}/tickets`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${APP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind, title, description, agentId, priority }),
    });

    if (response.status === 409) {
      const body = await response.json();
      logger.warn({ event: 'agent.tool.create_permaship_ticket', statusCode: 409, success: false, orgId, agentId });
      return { success: false, message: `A conflicting ticket or state lock exists (waiting_for_human). Please ask the user for manual approval or clarification. Detail: ${body.error}` };
    }

    if (response.status === 422) {
      const body = await response.json();
      logger.warn({ event: 'agent.tool.create_permaship_ticket', statusCode: 422, success: false, orgId, agentId });
      return { success: false, message: `The ticket request cannot be processed in the current state. Please ask the user to clarify the required details. Detail: ${body.error}` };
    }

    if (!response.ok) {
      logger.error({ event: 'agent.tool.create_permaship_ticket', statusCode: response.status, success: false, orgId, agentId });
      return { success: false, message: `Unexpected error creating ticket (HTTP ${response.status}). Please ask the user to verify the orchestrator is reachable.` };
    }

    const data = await response.json();
    logger.info({ event: 'agent.tool.create_permaship_ticket', statusCode: response.status, success: true, orgId, agentId });
    return { success: true, message: `Ticket created: ${data.id}`, ticketId: data.id };
  } catch (err) {
    logger.error({ event: 'agent.tool.create_permaship_ticket', success: false, orgId, agentId, err });
    return { success: false, message: 'An unexpected error occurred. Please ask the user to verify the orchestrator is reachable and try again.' };
  }
}
