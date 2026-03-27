// src/idle/allocator.ts — Weighted per-project allocation for idle prompts

import { db } from '../db/index.js';
import { activityLog } from '../db/schema.js';
import { eq, and, gte, inArray, count, sql } from 'drizzle-orm';
import { getAllProjectPolicies } from './policy-resolver.js';
import { resolveOperatingWindow } from './policy-resolver.js';
import { isWithinOperatingWindow, getEffectiveTicketsPerDay } from './project-policy.js';
import { computeBackpressure } from './backpressure.js';
import { computeProjectThrottleLevel } from './throttle.js';
import { getSetting } from '../settings/service.js';
import { logger } from '../logger.js';
import type { SuppressionReason } from './suppression.js';

export interface AllocationResult {
  projectId: string;
  projectName: string;
  suppressionReasons: SuppressionReason[];
}

export interface SuppressionReport {
  projectId: string;
  projectName: string;
  reasons: SuppressionReason[];
}

/**
 * Select the next project for an idle prompt. Returns null if all projects are suppressed.
 *
 * Stage 1 — Eligibility: filter out off, outside window, target reached, throttled
 * Stage 2 — Weighted random: proportional to (targetToday - ticketsToday) * (1 - backpressure * 0.5)
 */
export async function allocateNextProject(orgId: string): Promise<AllocationResult | null> {
  // Check shadow mode
  const shadowMode = await getSetting('nexus_improvements_shadow', orgId);
  const isShadow = shadowMode === true;

  const projects = await getAllProjectPolicies(orgId);
  if (projects.length === 0) return null;

  const eligible: Array<{
    projectId: string;
    projectName: string;
    weight: number;
  }> = [];

  const suppressions: SuppressionReport[] = [];

  for (const project of projects) {
    const reasons: SuppressionReason[] = [];

    // Focus off
    if (project.policy.focusLevel === 'off') {
      reasons.push('focus_off');
      suppressions.push({ projectId: project.id, projectName: project.name, reasons });
      continue;
    }

    // Operating window
    const window = await resolveOperatingWindow(orgId, project.id);
    if (!isWithinOperatingWindow(window)) {
      reasons.push('outside_operating_window');
      suppressions.push({ projectId: project.id, projectName: project.name, reasons });
      continue;
    }

    // Daily target check
    const targetPerDay = getEffectiveTicketsPerDay(project.policy);
    const ticketsToday = await countProjectIdleToday(orgId, project.id);
    if (ticketsToday >= targetPerDay) {
      reasons.push('daily_target_reached');
      suppressions.push({ projectId: project.id, projectName: project.name, reasons });
      continue;
    }

    // Per-project throttle
    const throttle = await computeProjectThrottleLevel(orgId, project.id);
    if (throttle.level === 'paused') {
      reasons.push('throttle_paused');
      suppressions.push({ projectId: project.id, projectName: project.name, reasons });
      continue;
    }

    // Compute backpressure
    const backpressure = await computeBackpressure(orgId, project.id);
    if (backpressure >= 0.9) {
      reasons.push('high_backpressure');
      suppressions.push({ projectId: project.id, projectName: project.name, reasons });
      continue;
    }

    // Weight = remaining budget * (1 - backpressure dampening)
    const remaining = Math.max(0, targetPerDay - ticketsToday);
    const weight = remaining * (1 - backpressure * 0.5);

    if (weight > 0) {
      eligible.push({ projectId: project.id, projectName: project.name, weight });
    }
  }

  if (eligible.length === 0) {
    logger.info({ orgId, suppressionCount: suppressions.length }, 'All projects suppressed, skipping idle');
    return null;
  }

  // Weighted random selection
  const selected = weightedRandom(eligible);

  if (isShadow) {
    // Shadow mode: log the decision but return null so old behavior continues
    logger.info({
      orgId,
      shadowAllocation: selected.projectName,
      eligible: eligible.map(e => ({ name: e.projectName, weight: e.weight })),
      suppressions: suppressions.map(s => ({ name: s.projectName, reasons: s.reasons })),
    }, 'Shadow allocation decision (not applied)');
    return null;
  }

  return {
    projectId: selected.projectId,
    projectName: selected.projectName,
    suppressionReasons: [],
  };
}

/** Count idle prompts for a specific project today */
async function countProjectIdleToday(orgId: string, projectId: string): Promise<number> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [result] = await db
      .select({ value: count() })
      .from(activityLog)
      .where(and(
        eq(activityLog.orgId, orgId),
        inArray(activityLog.kind, ['idle_prompt', 'idle_queued']),
        gte(activityLog.createdAt, todayStart),
        sql`${activityLog.metadata}->>'projectId' = ${projectId}`,
      ));

    return result?.value ?? 0;
  } catch (err) {
    logger.warn({ err, orgId, projectId }, 'Failed to count project idle prompts today');
    return 0;
  }
}

function weightedRandom<T extends { weight: number }>(items: T[]): T {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;

  for (const item of items) {
    random -= item.weight;
    if (random <= 0) return item;
  }

  return items[items.length - 1]; // fallback
}

/**
 * Get current allocation overview for an org — used by !focus list and UI.
 */
export async function getAllocationOverview(orgId: string): Promise<{
  projects: Array<{
    id: string;
    name: string;
    focusLevel: string;
    ticketsPerDay: number;
    ticketsToday: number;
    backpressure: number;
    suppressed: boolean;
    suppressionReasons: SuppressionReason[];
  }>;
  dailyTotal: number;
}> {
  const projects = await getAllProjectPolicies(orgId);
  const overview = [];
  let dailyTotal = 0;

  for (const project of projects) {
    const ticketsPerDay = getEffectiveTicketsPerDay(project.policy);
    const ticketsToday = await countProjectIdleToday(orgId, project.id);
    const backpressure = await computeBackpressure(orgId, project.id);

    const reasons: SuppressionReason[] = [];
    if (project.policy.focusLevel === 'off') reasons.push('focus_off');

    const window = await resolveOperatingWindow(orgId, project.id);
    if (!isWithinOperatingWindow(window)) reasons.push('outside_operating_window');
    if (ticketsToday >= ticketsPerDay && ticketsPerDay > 0) reasons.push('daily_target_reached');
    if (backpressure >= 0.9) reasons.push('high_backpressure');

    dailyTotal += ticketsPerDay;

    overview.push({
      id: project.id,
      name: project.name,
      focusLevel: project.policy.focusLevel,
      ticketsPerDay,
      ticketsToday,
      backpressure,
      suppressed: reasons.length > 0,
      suppressionReasons: reasons,
    });
  }

  return { projects: overview, dailyTotal };
}
