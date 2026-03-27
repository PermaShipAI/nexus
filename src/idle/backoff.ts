// src/idle/backoff.ts
import { db } from '../db/index.js';
import { activityLog } from '../db/schema.js';
import { eq, and, gte, inArray, count, sql } from 'drizzle-orm';
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

/**
 * Get the effective daily idle cap for an org.
 * Priority: per-org bot_settings override → billing API (plan tier + admin override) → hardcoded default.
 */
export async function getMaxIdlePer24h(orgId: string): Promise<number> {
  // 1. Local bot_settings override (highest priority)
  try {
    const raw = await getSetting('max_idle_per_24h', orgId);
    // JSONB may return number or string depending on how the value was stored
    const override = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
    if (!isNaN(override) && override > 0) return override;
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to read max_idle_per_24h setting');
  }

  // 2. Billing API via adapters (plan-tier-aware, with admin dashboard overrides)
  try {
    const mod = await (Function('return import("@permaship/agents-adapters")')() as Promise<Record<string, unknown>>);
    const fetch = mod.fetchAgentLimits as
      ((id: string) => Promise<{ maxIdlePromptsPerDay: number } | null>) | undefined;
    if (fetch) {
      const limits = await fetch(orgId);
      if (limits && limits.maxIdlePromptsPerDay > 0) return limits.maxIdlePromptsPerDay;
    }
  } catch {
    // OSS mode — adapters package not installed, fall through to default
  }

  return MAX_IDLE_PER_24H;
}

/** Count idle invocations for a specific project in the last 24h */
export async function getProjectIdleInvocations24h(orgId: string, projectId: string): Promise<number> {
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
          // Filter on metadata->>'projectId' = projectId
          sql`${activityLog.metadata}->>'projectId' = ${projectId}`,
        ),
      );
    return result?.value ?? 0;
  } catch (err) {
    logger.warn({ err, orgId, projectId }, 'Failed to count project idle invocations');
    return 0;
  }
}

/**
 * Get the effective daily budget using monthly pacing (preferred) or plan-tier cap.
 * Falls back to getMaxIdlePer24h if monthly pacing module is unavailable.
 */
export async function getEffectiveDailyBudget(orgId: string): Promise<number> {
  try {
    const { getEffectiveDailyBudget: pacingBudget } = await import('./monthly-pacing.js');
    return pacingBudget(orgId);
  } catch {
    return getMaxIdlePer24h(orgId);
  }
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
