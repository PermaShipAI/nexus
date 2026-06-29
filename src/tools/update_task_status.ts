import { getTaskById, updateTaskStatus } from '../tasks/service.js';
import { logToolRejectionEvent } from '../../agents/telemetry/logger.js';
import type { Task } from '../db/schema.js';
import type { AgentId } from '../agents/types.js';

export interface UpdateTaskStatusInput {
  orgId: string;
  taskId: string;
  newStatus: 'approved' | 'in_progress' | 'completed';
  agentId: string;
}

export interface UpdateTaskStatusResult {
  success: boolean;
  message?: string;
  error?: string;
  remediation_instruction?: string;
  task?: Task;
}

export async function updateTaskStatusTool(
  input: UpdateTaskStatusInput,
): Promise<UpdateTaskStatusResult> {
  const { orgId, taskId, newStatus, agentId } = input;

  try {
    const task = await getTaskById(taskId, orgId);

    if (!task) {
      return {
        success: false,
        error: 'Task not found',
        message: `Task ${taskId} was not found in org ${orgId}.`,
      };
    }

    if (task.status === 'proposed') {
      logToolRejectionEvent({
        toolName: 'update_task_status',
        agentId,
        orgId,
        taskId,
        currentStatus: task.status,
        attemptedStatus: newStatus,
      });
      return {
        success: false,
        error: 'State Transition Rejected',
        remediation_instruction:
          "The ticket is locked in 'proposed' pending mandatory Nexus DoD approval. You MUST reply to the user instructing them to manually review and approve the task via the Nexus Command web dashboard.",
      };
    }

    const updatedTask = await updateTaskStatus(taskId, orgId, newStatus, agentId as AgentId);

    return {
      success: true,
      message: `Task ${taskId} status updated to ${newStatus}.`,
      task: updatedTask ?? undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: 'Unexpected error',
      message: (err as Error).message,
    };
  }
}
