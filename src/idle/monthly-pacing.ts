// src/idle/monthly-pacing.ts — Monthly ticket pacing and budget calculation

import { db } from '../db/index.js';
import { activityLog } from '../db/schema.js';
import { eq, and, gte, inArray, count } from 'drizzle-orm';
import { getAllProjectPolicies } from './policy-resolver.js';
import { getEffectiveTicketsPerDay } from './project-policy.js';
import { logger } from '../logger.js';

/**
 * Compute the monthly output target based on active project policies.
 * Sum of (ticketsPerDay × daysInMonth) across all non-off projects.
 */
export async function getMonthlyOutputTarget(orgId: string): Promise<number> {
  try {
    const projects = await getAllProjectPolicies(orgId);
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    let total = 0;
    for (const p of projects) {
      total += getEffectiveTicketsPerDay(p.policy) * daysInMonth;
    }
    return total;
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to compute monthly output target');
    return 0;
  }
}

/**
 * Count idle prompts this month (org-wide).
 */
export async function getMonthlyUsage(orgId: string): Promise<number> {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [result] = await db
      .select({ value: count() })
      .from(activityLog)
      .where(and(
        eq(activityLog.orgId, orgId),
        inArray(activityLog.kind, ['idle_prompt', 'idle_queued']),
        gte(activityLog.createdAt, monthStart),
      ));

    return result?.value ?? 0;
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to count monthly usage');
    return 0;
  }
}

/**
 * Compute the effective daily pace based on monthly progress.
 * (monthlyTarget - monthlyUsed) / daysRemaining
 */
export async function computeDailyPace(orgId: string): Promise<number> {
  const target = await getMonthlyOutputTarget(orgId);
  const used = await getMonthlyUsage(orgId);

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysRemaining = daysInMonth - now.getDate() + 1; // include today

  if (daysRemaining <= 0) return 0;
  return Math.max(0, Math.ceil((target - used) / daysRemaining));
}

/**
 * Get effective daily budget — uses monthly pacing as primary, with plan-tier safety cap.
 * The safety cap comes from getMaxIdlePer24h() which checks bot_settings and optional
 * external billing adapters.
 */
export async function getEffectiveDailyBudget(orgId: string): Promise<number> {
  const { getMaxIdlePer24h } = await import('./backoff.js');

  const target = await getMonthlyOutputTarget(orgId);
  const safetyCap = await getMaxIdlePer24h(orgId);

  // If no projects are configured (target === 0), fall back to the plan-tier cap
  // so idle prompts still work for orgs without project policies set up.
  if (target === 0) return safetyCap;

  const pace = await computeDailyPace(orgId);
  return Math.min(pace, safetyCap);
}

/**
 * Get monthly pacing overview for display.
 */
export async function getMonthlyPacingOverview(orgId: string): Promise<{
  monthlyTarget: number;
  monthlyUsed: number;
  dailyPace: number;
  daysRemaining: number;
}> {
  const monthlyTarget = await getMonthlyOutputTarget(orgId);
  const monthlyUsed = await getMonthlyUsage(orgId);
  const dailyPace = await computeDailyPace(orgId);

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysRemaining = daysInMonth - now.getDate() + 1;

  return { monthlyTarget, monthlyUsed, dailyPace, daysRemaining };
}
