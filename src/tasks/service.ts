import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tasks, type Task, type NewTask } from '../db/schema.js';
import type { AgentId } from '../agents/types.js';
import { logInvalidStateTransitionBlocked } from '../../agents/telemetry/logger.js';

const VALID_TASK_UPDATE_STATUSES = ['approved', 'in_progress', 'completed'] as const;

export async function createTask(input: {
  orgId: string;
  title: string;
  description: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  proposedByAgentId?: AgentId;
}): Promise<Task> {
  const [task] = await db
    .insert(tasks)
    .values({
      orgId: input.orgId,
      title: input.title,
      description: input.description,
      priority: input.priority ?? 'medium',
      proposedByAgentId: input.proposedByAgentId,
      status: 'proposed',
    })
    .returning();
  return task;
}

export async function updateTaskStatus(
  taskId: string,
  orgId: string,
  status: 'approved' | 'in_progress' | 'completed',
  assignedAgentId?: AgentId,
): Promise<Task | null> {
  // Fail-fast: block system-managed states (e.g. waiting_for_human, ci_running)
  if (!VALID_TASK_UPDATE_STATUSES.includes(status as (typeof VALID_TASK_UPDATE_STATUSES)[number])) {
    logInvalidStateTransitionBlocked({ orgId, taskId, requestedStatus: status as string, agentId: assignedAgentId });
    throw new Error(
      `Blocked: '${status}' is a system-managed state. Tasks in 'waiting_for_human' require explicit human approval. Halt execution and await approval.`,
    );
  }

  const values: Partial<NewTask> = {
    status,
    updatedAt: new Date(),
  };
  if (assignedAgentId) {
    values.assignedAgentId = assignedAgentId;
  }

  const [task] = await db
    .update(tasks)
    .set(values)
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)))
    .returning();
  return task ?? null;
}

export async function listTasks(filters?: {
  orgId?: string;
  status?: Task['status'];
  assignedAgentId?: AgentId;
}): Promise<Task[]> {
  const conditions = [];
  if (filters?.orgId) {
    conditions.push(eq(tasks.orgId, filters.orgId));
  }
  if (filters?.status) {
    conditions.push(eq(tasks.status, filters.status));
  }
  if (filters?.assignedAgentId) {
    conditions.push(eq(tasks.assignedAgentId, filters.assignedAgentId));
  }

  if (conditions.length === 0) {
    return db.select().from(tasks);
  }

  return db
    .select()
    .from(tasks)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions));
}

export async function getUnassignedApprovedTasks(orgId: string): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.orgId, orgId),
      eq(tasks.status, 'approved'), 
      isNull(tasks.assignedAgentId)
    ));
}

export async function getTaskById(taskId: string, orgId: string): Promise<Task | null> {
  const [task] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId))).limit(1);
  return task ?? null;
}
