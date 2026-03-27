import { db } from '../db/index.js';
import { pendingActions } from '../db/schema.js';
import { eq, gte, and, or, ne, count, isNotNull, inArray } from 'drizzle-orm';
import { getProjectRegistry, getTicketTracker } from '../adapters/registry.js';
import { getSetting, setSetting } from '../settings/service.js';
import { logActivity } from './activity.js';
import { logger } from '../logger.js';

// --- Types ---

export type ThrottleLevel = 'normal' | 'reduced' | 'review_only' | 'paused';

export interface ThrottleConfig {
  backlog: { reduced: number; review_only: number; paused: number };
  velocity: { reduced: number; review_only: number; paused: number };
  windowDays: number;
  minProposals: number;
}

export interface ThrottleMetrics {
  level: ThrottleLevel;
  pendingCount: number;
  created: number;
  resolved: number;
  velocity: number | null; // null when insufficient data
  backlogLevel: ThrottleLevel;
  velocityLevel: ThrottleLevel;
  reason: string;
}

// --- Config ---

const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  backlog: { reduced: 20, review_only: 50, paused: 80 },
  velocity: { reduced: 0.5, review_only: 0.25, paused: 0.1 },
  windowDays: 7,
  minProposals: 3,
};

const LEVEL_SEVERITY: Record<ThrottleLevel, number> = {
  normal: 0,
  reduced: 1,
  review_only: 2,
  paused: 3,
};

/** In-memory cache of last known level per org, for transition logging */
const lastKnownLevel = new Map<string, ThrottleLevel>();

// --- Config loading ---

export async function getThrottleConfig(orgId: string): Promise<ThrottleConfig> {
  try {
    const overrides = await getSetting('idle_throttle_config', orgId) as Partial<ThrottleConfig> | null;
    if (!overrides) return DEFAULT_THROTTLE_CONFIG;
    return {
      backlog: { ...DEFAULT_THROTTLE_CONFIG.backlog, ...overrides.backlog },
      velocity: { ...DEFAULT_THROTTLE_CONFIG.velocity, ...overrides.velocity },
      windowDays: overrides.windowDays ?? DEFAULT_THROTTLE_CONFIG.windowDays,
      minProposals: overrides.minProposals ?? DEFAULT_THROTTLE_CONFIG.minProposals,
    };
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to load throttle config, using defaults');
    return DEFAULT_THROTTLE_CONFIG;
  }
}

// --- Data queries ---

/** Count total pending suggestions across all projects for an org */
export async function countPendingSuggestions(orgId: string): Promise<number> {
  try {
    const projects = await getProjectRegistry().listProjects(orgId);
    let total = 0;
    for (const project of projects) {
      const suggestions = await getTicketTracker().listSuggestions(orgId, project.id, { status: 'pending' });
      total += suggestions.length;
    }
    return total;
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to count pending suggestions');
    return 0;
  }
}

/** Query created and resolved proposal counts within a rolling window.
 *  Excludes proposals still in `nexus_review` from the created count — they
 *  haven't had a chance to be resolved yet and shouldn't penalise velocity. */
export async function queryProcessingMetrics(
  orgId: string,
  windowDays: number,
): Promise<{ created: number; resolved: number }> {
  try {
    const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    // Only count proposals that have progressed past nexus_review (i.e. Nexus
    // actually made a decision).  Proposals still waiting for Nexus are excluded
    // so they don't drag velocity toward zero and trigger a throttle death-spiral.
    const [createdResult] = await db
      .select({ value: count() })
      .from(pendingActions)
      .where(and(
        eq(pendingActions.orgId, orgId),
        gte(pendingActions.createdAt, windowStart),
        ne(pendingActions.status, 'nexus_review'),
      ));

    // Count proposals as "resolved" if they were explicitly resolved (resolvedAt set)
    // OR if a suggestion was created for them (suggestionId set) — meaning they were
    // processed through the pipeline even if the user acted via the dashboard, not Discord.
    const [resolvedResult] = await db
      .select({ value: count() })
      .from(pendingActions)
      .where(and(
        eq(pendingActions.orgId, orgId),
        or(
          gte(pendingActions.resolvedAt, windowStart),
          and(
            isNotNull(pendingActions.suggestionId),
            gte(pendingActions.createdAt, windowStart),
          ),
        ),
      ));

    return {
      created: createdResult?.value ?? 0,
      resolved: resolvedResult?.value ?? 0,
    };
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to query processing metrics');
    return { created: 0, resolved: 0 };
  }
}

// --- Level computation ---

function backlogToLevel(pending: number, thresholds: ThrottleConfig['backlog']): ThrottleLevel {
  if (pending >= thresholds.paused) return 'paused';
  if (pending >= thresholds.review_only) return 'review_only';
  if (pending >= thresholds.reduced) return 'reduced';
  return 'normal';
}

function velocityToLevel(
  rate: number | null,
  thresholds: ThrottleConfig['velocity'],
): ThrottleLevel {
  if (rate === null) return 'normal'; // insufficient data
  if (rate <= thresholds.paused) return 'paused';
  if (rate <= thresholds.review_only) return 'review_only';
  if (rate <= thresholds.reduced) return 'reduced';
  return 'normal';
}

function moreRestrictive(a: ThrottleLevel, b: ThrottleLevel): ThrottleLevel {
  return LEVEL_SEVERITY[a] >= LEVEL_SEVERITY[b] ? a : b;
}

/** Main entry point — computes the throttle level for an org */
export async function computeThrottleLevel(orgId: string): Promise<ThrottleMetrics> {
  const cfg = await getThrottleConfig(orgId);

  const [pendingCount, metrics] = await Promise.all([
    countPendingSuggestions(orgId),
    queryProcessingMetrics(orgId, cfg.windowDays),
  ]);

  const backlogLevel = backlogToLevel(pendingCount, cfg.backlog);

  // Compute velocity — only when we have enough proposals to be meaningful
  let velocity: number | null = null;
  if (metrics.created >= cfg.minProposals) {
    velocity = metrics.resolved / metrics.created;
  } else if (metrics.created === 0) {
    velocity = 1.0; // no proposals → treat as normal
  }
  // else: created > 0 but < minProposals → null (insufficient data)

  const velocityLevel = velocityToLevel(velocity, cfg.velocity);
  const level = moreRestrictive(backlogLevel, velocityLevel);

  // Build human-readable reason
  const reasons: string[] = [];
  if (backlogLevel !== 'normal') reasons.push(`backlog=${pendingCount} (${backlogLevel})`);
  if (velocityLevel !== 'normal') {
    reasons.push(`velocity=${velocity !== null ? velocity.toFixed(2) : 'n/a'} (${velocityLevel})`);
  }
  const reason = reasons.length > 0 ? reasons.join(', ') : 'all signals normal';

  // Log level transitions
  const prev = lastKnownLevel.get(orgId);
  if (prev && prev !== level) {
    logger.info(
      { orgId, previousLevel: prev, newLevel: level, reason },
      'Idle throttle level changed',
    );
  }
  lastKnownLevel.set(orgId, level);

  // Record metrics for historical analysis
  await logActivity('idle_throttle', undefined, undefined, orgId, {
    level,
    pendingCount,
    created: metrics.created,
    resolved: metrics.resolved,
    velocity,
    backlogLevel,
    velocityLevel,
    reason,
  });

  return {
    level,
    pendingCount,
    created: metrics.created,
    resolved: metrics.resolved,
    velocity,
    backlogLevel,
    velocityLevel,
    reason,
  };
}

// --- Per-project throttle ---

const PROJECT_THROTTLE_CONFIG = {
  backlog: { reduced: 5, review_only: 12, paused: 20 },
};

export interface ProjectThrottleMetrics {
  level: ThrottleLevel;
  pendingCount: number;
  reason: string;
}

/** Compute throttle level for a specific project (smaller thresholds than org-wide) */
export async function computeProjectThrottleLevel(orgId: string, projectId: string): Promise<ProjectThrottleMetrics> {
  try {
    const [result] = await db
      .select({ value: count() })
      .from(pendingActions)
      .where(and(
        eq(pendingActions.orgId, orgId),
        eq(pendingActions.projectId, projectId),
        inArray(pendingActions.status, ['pending', 'nexus_review']),
      ));

    const pendingCount = result?.value ?? 0;
    const level = backlogToLevel(pendingCount, PROJECT_THROTTLE_CONFIG.backlog);
    const reason = level !== 'normal'
      ? `project backlog=${pendingCount} (${level})`
      : 'project backlog normal';

    return { level, pendingCount, reason };
  } catch (err) {
    logger.warn({ err, orgId, projectId }, 'Failed to compute project throttle level');
    return { level: 'normal', pendingCount: 0, reason: 'error fallback' };
  }
}

// --- Suggestion creation gate ---

/** Determine whether a suggestion should be created for an approved proposal.
 *  User-sourced proposals always pass; idle/system-sourced are subject to throttle. */
export async function shouldCreateSuggestion(orgId: string, source: string | null): Promise<boolean> {
  if (source === 'user') return true;
  const metrics = await computeThrottleLevel(orgId);
  return metrics.level === 'normal' || metrics.level === 'reduced';
}

// --- Reduced-mode alternation ---

/** For `reduced` mode: returns true on odd cycles (create new work), false on even (review) */
export async function shouldCreateNewWork(orgId: string): Promise<boolean> {
  try {
    const current = (await getSetting('idle_reduced_counter', orgId) as number) ?? 0;
    const next = current + 1;
    await setSetting('idle_reduced_counter', next, orgId, 'system');
    return next % 2 === 1; // odd = create new, even = review
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to read/update reduced counter, defaulting to new work');
    return true;
  }
}
