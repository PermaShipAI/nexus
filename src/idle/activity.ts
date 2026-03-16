import { and, desc, eq, inArray, not } from 'drizzle-orm';
import { db } from '../db/index.js';
import { activityLog } from '../db/schema.js';
import type { AgentId } from '../agents/types.js';

export async function logActivity(
  kind: string,
  agentId: AgentId | undefined,
  channelId: string | undefined,
  orgId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db.insert(activityLog).values({
    orgId,
    kind,
    agentId: agentId ?? null,
    channelId: channelId ?? null,
    metadata: metadata ?? null,
  });
}

export async function getLastActivityTimestamp(orgId: string): Promise<Date | null> {
  const [latest] = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(eq(activityLog.orgId, orgId))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);

  return latest?.createdAt ?? null;
}

/** Activity kinds that are system-initiated and should NOT count as human activity */
const SYSTEM_KINDS = [
  'idle_prompt',
  'idle_queued',
  'idle_throttle',
  'nexus_review_cycle',
  'security_digest',
  'system_startup',
] as const;

export async function getLastHumanActivityTimestamp(orgId: string): Promise<Date | null> {
  const [latest] = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.orgId, orgId),
        not(inArray(activityLog.kind, [...SYSTEM_KINDS])),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  return latest?.createdAt ?? null;
}

export async function getLastIdleTimestamp(orgId: string): Promise<Date | null> {
  const [latest] = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.orgId, orgId),
        inArray(activityLog.kind, ['idle_prompt', 'idle_queued']),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  return latest?.createdAt ?? null;
}
