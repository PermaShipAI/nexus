import { logger } from '../../logger.js';
import {
  logCircuitBreakerTripped,
  logCircuitBreakerReset,
  logDegradedModeActive,
  logDegradedModeCleared,
  logRequestRejectedDegraded,
} from '../../telemetry/infrastructure.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type DependencyName = 'llm_provider' | 'github_api' | 'pgboss_queue';

interface BreakerConfig {
  /** Number of consecutive 5xx failures within the window required to trip the breaker. */
  tripThreshold: number;
  /** Rolling window duration in ms for counting failures. */
  windowMs: number;
  /** Time in ms to wait in OPEN state before transitioning to HALF_OPEN for a probe. */
  resetWindowMs: number;
}

const CONFIGS: Record<DependencyName, BreakerConfig> = {
  github_api:   { tripThreshold: 3, windowMs: 60_000,  resetWindowMs: 120_000 },
  pgboss_queue: { tripThreshold: 1, windowMs: 30_000,  resetWindowMs: 30_000  },
  llm_provider: { tripThreshold: 5, windowMs: 120_000, resetWindowMs: 180_000 },
};

interface BreakerState {
  state: CircuitState;
  /** Timestamps of recent failures within the window. */
  failureTimes: number[];
  /** When the breaker was tripped (OPEN transition), for reset-window tracking. */
  openedAt: number | null;
  /** Total number of times this breaker has tripped. */
  tripCount: number;
}

const breakers = new Map<DependencyName, BreakerState>();

function getBreaker(dep: DependencyName): BreakerState {
  if (!breakers.has(dep)) {
    breakers.set(dep, { state: 'CLOSED', failureTimes: [], openedAt: null, tripCount: 0 });
  }
  return breakers.get(dep)!;
}

function anyOpen(): DependencyName[] {
  const open: DependencyName[] = [];
  for (const dep of breakers.keys()) {
    if (getState(dep) === 'OPEN') open.push(dep);
  }
  return open;
}

/**
 * Returns the current circuit state, advancing OPEN → HALF_OPEN when the
 * reset window has elapsed.
 */
export function getState(dep: DependencyName): CircuitState {
  const b = getBreaker(dep);
  if (b.state === 'OPEN' && b.openedAt !== null) {
    const elapsed = Date.now() - b.openedAt;
    if (elapsed >= CONFIGS[dep].resetWindowMs) {
      b.state = 'HALF_OPEN';
      logger.info({ event: 'circuit_breaker.half_open', dependency: dep }, 'Circuit breaker entering HALF_OPEN for probe');
    }
  }
  return b.state;
}

/**
 * Returns the number of seconds until the circuit breaker may accept a probe
 * request (i.e., the remaining reset window). Returns 0 if already HALF_OPEN
 * or CLOSED.
 */
export function retryAfterSeconds(dep: DependencyName): number {
  const b = getBreaker(dep);
  if (b.state !== 'OPEN' || b.openedAt === null) return 0;
  const elapsed = Date.now() - b.openedAt;
  const remaining = CONFIGS[dep].resetWindowMs - elapsed;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Record a successful call. Transitions HALF_OPEN → CLOSED.
 * Calls getState() first to allow any pending OPEN → HALF_OPEN transition.
 */
export function recordSuccess(dep: DependencyName): void {
  // Trigger any pending OPEN → HALF_OPEN transition before reading state.
  getState(dep);
  const b = getBreaker(dep);
  if (b.state === 'HALF_OPEN') {
    const downtimeMs = b.openedAt !== null ? Date.now() - b.openedAt : 0;
    b.state = 'CLOSED';
    b.failureTimes = [];
    b.openedAt = null;

    logCircuitBreakerReset({ dependency: dep, downtimeSeconds: Math.round(downtimeMs / 1000) });

    const stillOpen = anyOpen();
    if (stillOpen.length === 0) {
      logDegradedModeCleared();
    }
  } else if (b.state === 'CLOSED') {
    // Evict stale failures on success to prevent them from counting later.
    const cutoff = Date.now() - CONFIGS[dep].windowMs;
    b.failureTimes = b.failureTimes.filter(t => t >= cutoff);
  }
}

/**
 * Record a server-side (5xx) failure. Trips the breaker when the threshold
 * is exceeded within the rolling window.
 */
export function recordFailure(dep: DependencyName, reason: string): void {
  const b = getBreaker(dep);

  // Already open — nothing more to do (still in failure state).
  if (b.state === 'OPEN') return;

  const now = Date.now();
  const cutoff = now - CONFIGS[dep].windowMs;
  b.failureTimes = b.failureTimes.filter(t => t >= cutoff);
  b.failureTimes.push(now);

  if (b.failureTimes.length >= CONFIGS[dep].tripThreshold) {
    const wasAlreadyDegraded = anyOpen().length > 0;

    b.state = 'OPEN';
    b.openedAt = now;
    b.tripCount += 1;

    logCircuitBreakerTripped({
      dependency: dep,
      reason,
      tripCount: b.tripCount,
    });

    if (!wasAlreadyDegraded) {
      logDegradedModeActive({ affectedDependencies: [dep] });
    } else {
      // Collect full list now that this one is also OPEN.
      logDegradedModeActive({ affectedDependencies: anyOpen() });
    }

    logger.warn(
      { event: 'circuit_breaker.tripped', dependency: dep, tripCount: b.tripCount, reason },
      'Circuit breaker tripped — entering OPEN state',
    );
  }
}

/**
 * Check whether a request may proceed for a given dependency.
 * Returns `{ allowed: true }` when the circuit is CLOSED or HALF_OPEN.
 * Returns `{ allowed: false, retryAfter: number }` when the circuit is OPEN.
 */
export function checkCircuit(
  dep: DependencyName,
  endpoint: string,
): { allowed: true } | { allowed: false; retryAfter: number } {
  const state = getState(dep);
  if (state === 'OPEN') {
    const retryAfter = retryAfterSeconds(dep);
    logRequestRejectedDegraded({ dependency: dep, endpoint });
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

/**
 * Returns the list of dependencies whose circuit breaker is currently OPEN,
 * along with the earliest retry-after value across all of them.
 */
export function getDegradedDependencies(): { dependencies: DependencyName[]; maxRetryAfter: number } {
  const dependencies: DependencyName[] = [];
  let maxRetryAfter = 0;
  for (const dep of Object.keys(CONFIGS) as DependencyName[]) {
    if (getState(dep) === 'OPEN') {
      dependencies.push(dep);
      maxRetryAfter = Math.max(maxRetryAfter, retryAfterSeconds(dep));
    }
  }
  return { dependencies, maxRetryAfter };
}

/** Reset all breakers — intended for use in tests only. */
export function _resetAllBreakers(): void {
  breakers.clear();
}
