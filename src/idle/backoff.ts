// src/idle/backoff.ts
import { db } from '../db/index.js';
import { activityLog } from '../db/schema.js';
import { eq, and, gte, inArray, count } from 'drizzle-orm';
import { getSetting, setSetting } from '../settings/service.js';
import { logger } from '../logger.js';

export const BACKOFF_DELAYS_MS = [
  20 * 60 * 1000,       // Step 0: 20 minutes
  60 * 60 * 1000,       // Step 1: 1 hour
  4 * 60 * 60 * 1000,  // Step 2: 4 hours
  12 * 60 * 60 * 1000, // Step 3: 12 hours (max)
] as const;

export const MAX_IDLE_PER_24H = 5;

export const IDLE_ACTIVITY_KINDS = ['idle_prompt', 'idle_queued', 'idle_throttle'] as const;

const BACKOFF_SETTING_KEY = 'idle_backoff_step';
const MAX_STEP = BACKOFF_DELAYS_MS.length - 1;

export async function getBackoffStep(orgId: string): Promise<number> {
  try {
    const step = await getSetting(BACKOFF_SETTING_KEY, orgId) as number | null;
    if (typeof step === 'number') return Math.min(Math.max(0, step), MAX_STEP);
    return 0;
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to read idle_backoff_step, defaulting to 0');
    return 0;
  }
}

export async function incrementBackoffStep(orgId: string): Promise<void> {
  try {
    const current = await getBackoffStep(orgId);
    const next = Math.min(current + 1, MAX_STEP);
    await setSetting(BACKOFF_SETTING_KEY, next, orgId, 'system');
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to increment idle_backoff_step');
  }
}

export async function resetBackoffStep(orgId: string): Promise<void> {
  try {
    await setSetting(BACKOFF_SETTING_KEY, 0, orgId, 'system');
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to reset idle_backoff_step');
  }
}

/** Get the effective daily idle cap for an org (plan-aware, with admin override support). */
export async function getMaxIdlePer24h(orgId: string): Promise<number> {
  try {
    // Attempt to load the adapter-specific fetchAgentLimits function dynamically.
    // Falls back to the default limit if the module is not available (e.g. OSS / non-PermaShip deploys).
    const { fetchAgentLimits } = await import('../permaship/client.js');
    if (typeof fetchAgentLimits === 'function') {
      const limits = await fetchAgentLimits(orgId);
      if (limits) return limits.maxIdlePromptsPerDay;
    }
  } catch (err) {
    logger.warn({ err, orgId }, 'fetchAgentLimits not available, using default idle limit');
  }
  return MAX_IDLE_PER_24H;
}

export async function getIdleInvocations24h(orgId: string): Promise<number> {
  try {
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [result] = await db
      .select({ value: count() })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.orgId, orgId),
          inArray(activityLog.kind, ['idle_prompt', 'idle_queued']),
          gte(activityLog.createdAt, windowStart),
        ),
      );
    return result?.value ?? 0;
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to count idle invocations in 24h window, defaulting to 0');
    return 0;
  }
}
