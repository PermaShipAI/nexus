/**
 * Dependency-level circuit breaker for external infrastructure dependencies.
 *
 * Implements the three-state machine defined in docs/prd-phase2-circuit-breakers.md:
 *   CLOSED → OPEN → HALF_OPEN → CLOSED
 *
 * Per-dependency thresholds (PRD § 3.1):
 *   - github_api:     3 consecutive 5xx within 60 s  → OPEN for 120 s
 *   - queue_database: 1 failed health check          → OPEN for 30 s
 *   - llm_provider:   5 consecutive 5xx within 120 s → OPEN for 180 s
 */

import { logger } from '../logger.js';

export type DependencyName = 'github_api' | 'queue_database' | 'llm_provider';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BreakerConfig {
  tripThreshold: number;    // consecutive failures required to trip
  windowMs: number;         // rolling window for counting failures
  resetWindowMs: number;    // how long to stay OPEN before probing
}

const CONFIGS: Record<DependencyName, BreakerConfig> = {
  github_api:     { tripThreshold: 3, windowMs: 60_000,  resetWindowMs: 120_000 },
  queue_database: { tripThreshold: 1, windowMs: 60_000,  resetWindowMs:  30_000 },
  llm_provider:   { tripThreshold: 5, windowMs: 120_000, resetWindowMs: 180_000 },
};

interface BreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  firstFailureAt: number | null;   // epoch ms of the first failure in current window
  openedAt: number | null;         // epoch ms when the breaker last transitioned to OPEN
  tripCount: number;               // total trips since process start
}

function makeInitialState(): BreakerState {
  return {
    state: 'CLOSED',
    consecutiveFailures: 0,
    firstFailureAt: null,
    openedAt: null,
    tripCount: 0,
  };
}

// Singleton map of per-dependency breaker state (in-process only, per PRD open question 1)
const breakers = new Map<DependencyName, BreakerState>(
  (Object.keys(CONFIGS) as DependencyName[]).map(dep => [dep, makeInitialState()]),
);

// Track how many breakers are currently OPEN so we can fire degraded_mode_cleared exactly once
function openCount(): number {
  let n = 0;
  for (const s of breakers.values()) {
    if (s.state === 'OPEN' || s.state === 'HALF_OPEN') n++;
  }
  return n;
}

/**
 * Record a successful call to the given dependency.
 * If the breaker was HALF_OPEN this closes it.
 */
export function recordSuccess(dep: DependencyName): void {
  const s = breakers.get(dep)!;
  if (s.state === 'HALF_OPEN') {
    const prevOpen = openCount();
    const downtimeSeconds = s.openedAt ? Math.round((Date.now() - s.openedAt) / 1000) : 0;
    Object.assign(s, makeInitialState());

    logger.info({
      event: 'circuit_breaker_reset',
      dependency: dep,
      downtime_seconds: downtimeSeconds,
      timestamp: new Date().toISOString(),
    });

    if (prevOpen === 1) {
      // This was the last open breaker — system is fully recovered
      logger.info({ event: 'degraded_mode_cleared', timestamp: new Date().toISOString() });
    }
  } else if (s.state === 'CLOSED') {
    // Reset rolling failure counter on success
    s.consecutiveFailures = 0;
    s.firstFailureAt = null;
  }
}

/**
 * Record a failed call to the given dependency.
 * May transition the breaker to OPEN.
 */
export function recordFailure(dep: DependencyName, reason?: string): void {
  const s = breakers.get(dep)!;
  const cfg = CONFIGS[dep];
  const now = Date.now();

  if (s.state === 'OPEN') {
    // Already open — nothing to do
    return;
  }

  if (s.state === 'HALF_OPEN') {
    // Probe failed — re-open
    const prevOpen = openCount();
    s.state = 'OPEN';
    s.openedAt = now;
    s.tripCount++;
    logger.warn({
      event: 'circuit_breaker_tripped',
      dependency: dep,
      reason: reason ?? 'half_open_probe_failed',
      trip_count: s.tripCount,
      timestamp: new Date().toISOString(),
    });
    if (prevOpen === 0) {
      logger.warn({
        event: 'degraded_mode_active',
        affected_dependencies: [dep],
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  // CLOSED state — track failures within the rolling window
  if (s.firstFailureAt === null || now - s.firstFailureAt > cfg.windowMs) {
    // Start a new failure window
    s.firstFailureAt = now;
    s.consecutiveFailures = 1;
  } else {
    s.consecutiveFailures++;
  }

  if (s.consecutiveFailures >= cfg.tripThreshold) {
    const prevOpen = openCount();
    s.state = 'OPEN';
    s.openedAt = now;
    s.tripCount++;

    logger.warn({
      event: 'circuit_breaker_tripped',
      dependency: dep,
      reason: reason ?? `${s.consecutiveFailures}_consecutive_failures`,
      trip_count: s.tripCount,
      timestamp: new Date().toISOString(),
    });

    if (prevOpen === 0) {
      const openDeps = getOpenDependencies();
      logger.warn({
        event: 'degraded_mode_active',
        affected_dependencies: openDeps,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

/**
 * Returns true if the circuit breaker for the given dependency is OPEN
 * and should reject calls. Also transitions OPEN → HALF_OPEN if the reset
 * window has elapsed (allowing a probe through).
 */
export function isOpen(dep: DependencyName): boolean {
  const s = breakers.get(dep)!;
  const cfg = CONFIGS[dep];
  const now = Date.now();

  if (s.state === 'CLOSED') return false;

  if (s.state === 'OPEN' && s.openedAt !== null && now - s.openedAt >= cfg.resetWindowMs) {
    // Reset window elapsed — allow one probe
    s.state = 'HALF_OPEN';
    logger.info({
      event: 'circuit_breaker_half_open',
      dependency: dep,
      timestamp: new Date().toISOString(),
    });
  }

  return s.state === 'OPEN';
}

/**
 * Returns the number of seconds until the circuit breaker may allow a probe.
 * Returns 0 if the breaker is CLOSED or already in HALF_OPEN.
 */
export function retryAfterSeconds(dep: DependencyName): number {
  const s = breakers.get(dep)!;
  const cfg = CONFIGS[dep];
  if (s.state !== 'OPEN' || s.openedAt === null) return 0;
  const remaining = cfg.resetWindowMs - (Date.now() - s.openedAt);
  return Math.max(0, Math.ceil(remaining / 1000));
}

/** Returns the list of currently OPEN (or HALF_OPEN) dependency names. */
export function getOpenDependencies(): DependencyName[] {
  return (Object.keys(CONFIGS) as DependencyName[]).filter(dep => {
    const s = breakers.get(dep)!;
    return s.state === 'OPEN' || s.state === 'HALF_OPEN';
  });
}

/** Returns true if any circuit breaker is in a degraded (OPEN or HALF_OPEN) state. */
export function isAnyOpen(): boolean {
  return getOpenDependencies().length > 0;
}

/** Returns a snapshot of breaker states (for health endpoints / observability). */
export function getBreakerStates(): Record<DependencyName, CircuitState> {
  const out = {} as Record<DependencyName, CircuitState>;
  for (const [dep, s] of breakers.entries()) {
    out[dep] = s.state;
  }
  return out;
}

/** Reset all breakers to CLOSED — intended for tests only. */
export function _resetAllBreakers(): void {
  for (const dep of Object.keys(CONFIGS) as DependencyName[]) {
    breakers.set(dep, makeInitialState());
  }
}
