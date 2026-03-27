// src/idle/suppression.ts — Suppression reason tracking and reporting

import { resolveProjectPolicy, resolveOperatingWindow } from './policy-resolver.js';
import { isWithinOperatingWindow, getEffectiveTicketsPerDay } from './project-policy.js';
import { computeBackpressure } from './backpressure.js';
import { computeProjectThrottleLevel } from './throttle.js';
import { getProjectIdleInvocations24h } from './backoff.js';
import { logger } from '../logger.js';

export type SuppressionReason =
  | 'focus_off'
  | 'outside_operating_window'
  | 'daily_target_reached'
  | 'monthly_budget_exhausted'
  | 'high_backpressure'
  | 'throttle_paused'
  | 'plan_limit_reached'
  | 'no_active_repos';

export interface SuppressionDetail {
  reason: SuppressionReason;
  description: string;
}

const REASON_DESCRIPTIONS: Record<SuppressionReason, string> = {
  focus_off: 'Focus is set to Off — no idle prompts will be generated',
  outside_operating_window: 'Currently outside the configured operating window',
  daily_target_reached: 'Daily ticket target has been reached',
  monthly_budget_exhausted: 'Monthly ticket budget has been exhausted',
  high_backpressure: 'Too many unreviewed suggestions — review existing proposals first',
  throttle_paused: 'Per-project throttle is paused due to high backlog',
  plan_limit_reached: 'Organization plan limit has been reached',
  no_active_repos: 'No active repositories configured for this project',
};

export interface ProjectSuppressionReport {
  projectId: string;
  suppressed: boolean;
  reasons: SuppressionDetail[];
  backpressure: number;
  ticketsPerDay: number;
  ticketsToday: number;
  focusLevel: string;
}

/** Get a full suppression report for a single project */
export async function getProjectSuppressionReport(
  orgId: string,
  projectId: string,
): Promise<ProjectSuppressionReport> {
  const reasons: SuppressionDetail[] = [];

  try {
    const policy = await resolveProjectPolicy(orgId, projectId);
    const ticketsPerDay = getEffectiveTicketsPerDay(policy);

    if (policy.focusLevel === 'off') {
      reasons.push({ reason: 'focus_off', description: REASON_DESCRIPTIONS.focus_off });
    }

    const window = await resolveOperatingWindow(orgId, projectId);
    if (!isWithinOperatingWindow(window)) {
      reasons.push({ reason: 'outside_operating_window', description: REASON_DESCRIPTIONS.outside_operating_window });
    }

    // Use 24h window for "today" count (matches allocator logic)
    const ticketsToday = await getProjectIdleInvocations24h(orgId, projectId);
    if (ticketsToday >= ticketsPerDay && ticketsPerDay > 0) {
      reasons.push({
        reason: 'daily_target_reached',
        description: `${ticketsToday}/${ticketsPerDay} tickets today`,
      });
    }

    const backpressure = await computeBackpressure(orgId, projectId);
    if (backpressure >= 0.9) {
      reasons.push({
        reason: 'high_backpressure',
        description: `Backpressure at ${Math.round(backpressure * 100)}% — ${REASON_DESCRIPTIONS.high_backpressure}`,
      });
    }

    const throttle = await computeProjectThrottleLevel(orgId, projectId);
    if (throttle.level === 'paused') {
      reasons.push({
        reason: 'throttle_paused',
        description: `${throttle.reason}`,
      });
    }

    return {
      projectId,
      suppressed: reasons.length > 0,
      reasons,
      backpressure,
      ticketsPerDay,
      ticketsToday,
      focusLevel: policy.focusLevel,
    };
  } catch (err) {
    logger.warn({ err, orgId, projectId }, 'Failed to compute suppression report');
    return {
      projectId,
      suppressed: false,
      reasons: [],
      backpressure: 0,
      ticketsPerDay: 3,
      ticketsToday: 0,
      focusLevel: 'normal',
    };
  }
}

/** Get suppression reports for all projects */
export async function getAllSuppressionReports(
  orgId: string,
  projectIds: string[],
): Promise<ProjectSuppressionReport[]> {
  const reports: ProjectSuppressionReport[] = [];
  for (const projectId of projectIds) {
    reports.push(await getProjectSuppressionReport(orgId, projectId));
  }
  return reports;
}

/** Get human-readable description for a suppression reason */
export function getReasonDescription(reason: SuppressionReason): string {
  return REASON_DESCRIPTIONS[reason] ?? reason;
}
