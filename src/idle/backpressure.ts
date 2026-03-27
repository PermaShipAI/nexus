// src/idle/backpressure.ts — Per-project backpressure tracking

import { db } from '../db/index.js';
import { pendingActions, tickets } from '../db/schema.js';
import { eq, and, inArray, count, isNull, notInArray } from 'drizzle-orm';
import { logger } from '../logger.js';

/**
 * Compute backpressure for a specific project (0.0 = no pressure, 1.0 = max).
 *
 * Counts unresolved pending/nexus_review suggestions (proxy for ignored proposals).
 * Open execution tickets are excluded (healthy work in flight).
 */
export async function computeBackpressure(orgId: string, projectId: string): Promise<number> {
  try {
    // Count unresolved pending suggestions for this project
    const [staleResult] = await db
      .select({ value: count() })
      .from(pendingActions)
      .where(and(
        eq(pendingActions.orgId, orgId),
        eq(pendingActions.projectId, projectId),
        inArray(pendingActions.status, ['pending', 'nexus_review']),
        isNull(pendingActions.resolvedAt),
      ));
    const staleCount = staleResult?.value ?? 0;

    // Open execution tickets (work in flight) — not penalized
    const [executingResult] = await db
      .select({ value: count() })
      .from(tickets)
      .where(and(
        eq(tickets.orgId, orgId),
        notInArray(tickets.executionStatus, ['failed', 'success']),
      ));
    const executingCount = executingResult?.value ?? 0;

    // Effective stale = stale suggestions minus executing tickets (floor 0)
    const effectiveStale = Math.max(0, staleCount - executingCount);

    // Normalize: 10+ stale = max pressure
    const pressure = Math.min(1.0, effectiveStale / 10);

    return Math.round(pressure * 100) / 100;
  } catch (err) {
    logger.warn({ err, orgId, projectId }, 'Failed to compute backpressure');
    return 0;
  }
}

/**
 * Compute backpressure for all projects in an org.
 */
export async function computeAllBackpressure(orgId: string, projectIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const projectId of projectIds) {
    result.set(projectId, await computeBackpressure(orgId, projectId));
  }
  return result;
}
