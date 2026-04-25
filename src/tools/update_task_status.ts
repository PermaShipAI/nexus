import { AgentId } from '../agents/types.js';
import { logger } from '../logger.js';

export interface UpdateTaskStatusInput {
  orgId: string;
  taskId: string;
  status: string;
  agentId: AgentId;
}

export interface UpdateTaskStatusResult {
  success: boolean;
  message: string;
  taskId?: string;
  status?: string;
}

export async function updateTaskStatus(input: UpdateTaskStatusInput): Promise<UpdateTaskStatusResult> {
  const { orgId, taskId, status, agentId } = input;
  const APP_API_URL = process.env.APP_API_URL;
  const APP_API_KEY = process.env.APP_API_KEY;

  if (!APP_API_URL) {
    logger.warn({ event: 'agent.tool.conductor_url_missing', success: false });
    return { success: false, message: 'APP_API_URL is not configured. Please ask the user to verify the orchestrator URL and try again.' };
  }

  try {
    const response = await fetch(`${APP_API_URL}/api/orgs/${orgId}/tasks/${taskId}/status`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${APP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status, agentId }),
    });

    if (response.status === 409) {
      const body = await response.json();
      logger.warn({ event: 'agent.tool.update_task_status', statusCode: 409, success: false, taskId, agentId });
      return { success: false, message: `This task is locked by the orchestrator (waiting_for_human). Please ask the user for manual approval or clarification before retrying. Detail: ${body.error}` };
    }

    if (response.status === 422) {
      const body = await response.json();
      logger.warn({ event: 'agent.tool.update_task_status', statusCode: 422, success: false, taskId, agentId });
      return { success: false, message: `The requested state transition is invalid in the current workflow. Please ask the user to clarify the intended next step. Detail: ${body.error}` };
    }

    if (!response.ok) {
      await response.json().catch(() => ({}));
      logger.error({ event: 'agent.tool.update_task_status', statusCode: response.status, success: false, taskId, agentId });
      return { success: false, message: `Unexpected error updating task status (HTTP ${response.status}). Please ask the user to verify the orchestrator is reachable.` };
    }

    await response.json();
    logger.info({ event: 'agent.tool.update_task_status', statusCode: response.status, success: true, taskId, agentId });
    return { success: true, message: `Task ${taskId} status updated to "${status}" successfully.`, taskId, status };
  } catch (err) {
    logger.error({ event: 'agent.tool.update_task_status', success: false, taskId, agentId, err });
    return { success: false, message: 'An unexpected error occurred. Please ask the user to verify the orchestrator is reachable and try again.' };
  }
}
