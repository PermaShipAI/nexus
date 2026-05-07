/**
 * Circuit Breaker — Phase 2 Cascading Failure Protection
 *
 * Implements a three-state circuit breaker (CLOSED → OPEN → HALF_OPEN) per
 * external dependency per the PRD requirements (docs/prd-phase2-circuit-breakers.md).
 *
 * Dependency thresholds:
 *   github_api   – 3 consecutive 5xx within 60 s → 120 s half-open probe
 *   pg_boss      – 1 failure                     → 30 s probe
 *   llm_provider – 5 consecutive 5xx within 120 s → 180 s half-open probe
 */

import {
  logCircuitBreakerTripped,
  logCircuitBreakerReset,
  logDegradedModeActive,
  logDegradedModeCleared,
  logRequestRejectedDegraded,
} from '../../agents/telemetry/logger.js';
import {
  circuitBreakerStateGauge,
  circuitBreakerTripTotal,
  circuitBreakerRejectTotal,
} from '../telemetry/prometheus.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type DependencyName = 'github_api' | 'pg_boss' | 'llm_provider';

interface BreakerConfig {
  /** Number of consecutive 5xx failures before tripping. */
  failureThreshold: number;
  /** Time window (ms) in which failures must accumulate to trip the breaker. */
  windowMs: number;
  /** How long (ms) to stay OPEN before allowing a probe (HALF_OPEN). */
  resetWindowMs: number;
}

interface BreakerState {
  state: CircuitState;
  /** Timestamps of recent failures (within the rolling window). */
  recentFailures: number[];
  /** When the breaker entered OPEN state (ms epoch). */
  openedAt: number | null;
  /** How many times this breaker has tripped since process start. */
  tripCount: number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIGS: Record<DependencyName, BreakerConfig> = {
  github_api: {
    failureThreshold: 3,
    windowMs: 60_000,
    resetWindowMs: 120_000,
  },
  pg_boss: {
    failureThreshold: 1,
    windowMs: 60_000,   // window is irrelevant for threshold=1 but kept for consistency
    resetWindowMs: 30_000,
  },
  llm_provider: {
    failureThreshold: 5,
    windowMs: 120_000,
    resetWindowMs: 180_000,
  },
};

// ── In-process state store ────────────────────────────────────────────────────

const states = new Map<DependencyName, BreakerState>([
  ['github_api', { state: 'CLOSED', recentFailures: [], openedAt: null, tripCount: 0 }],
  ['pg_boss',    { state: 'CLOSED', recentFailures: [], openedAt: null, tripCount: 0 }],
  ['llm_provider', { state: 'CLOSED', recentFailures: [], openedAt: null, tripCount: 0 }],
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getState(dep: DependencyName): BreakerState {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return states.get(dep)!;
}

function openBreakers(): DependencyName[] {
  return (Array.from(states.entries()) as [DependencyName, BreakerState][])
    .filter(([, s]) => s.state === 'OPEN' || s.state === 'HALF_OPEN')
    .map(([dep]) => dep);
}

function degradedDependencies(): DependencyName[] {
  return (Array.from(states.entries()) as [DependencyName, BreakerState][])
    .filter(([, s]) => s.state === 'OPEN')
    .map(([dep]) => dep);
}

/** Transition breaker to OPEN state and emit telemetry. */
function trip(dep: DependencyName, s: BreakerState, cfg: BreakerConfig, reason: string): void {
  const wasOpen = openBreakers().length > 0;

  s.state = 'OPEN';
  s.openedAt = Date.now();
  s.tripCount += 1;

  circuitBreakerStateGauge.set({ dependency: dep, state: 'OPEN' }, 1);
  circuitBreakerStateGauge.set({ dependency: dep, state: 'CLOSED' }, 0);
  circuitBreakerStateGauge.set({ dependency: dep, state: 'HALF_OPEN' }, 0);
  circuitBreakerTripTotal.inc({ dependency: dep });

  logCircuitBreakerTripped({
    dependency: dep,
    reason,
    trip_count: s.tripCount,
    timestamp: new Date().toISOString(),
  });

  if (!wasOpen) {
    logDegradedModeActive({
      affected_dependencies: degradedDependencies(),
      timestamp: new Date().toISOString(),
    });
  }
}

/** Transition breaker back to CLOSED state and emit telemetry. */
function close(dep: DependencyName, s: BreakerState): void {
  const openedAt = s.openedAt ?? Date.now();
  const downtimeSeconds = Math.round((Date.now() - openedAt) / 1000);

  s.state = 'CLOSED';
  s.recentFailures = [];
  s.openedAt = null;

  circuitBreakerStateGauge.set({ dependency: dep, state: 'CLOSED' }, 1);
  circuitBreakerStateGauge.set({ dependency: dep, state: 'OPEN' }, 0);
  circuitBreakerStateGauge.set({ dependency: dep, state: 'HALF_OPEN' }, 0);

  logCircuitBreakerReset({
    dependency: dep,
    downtime_seconds: downtimeSeconds,
    timestamp: new Date().toISOString(),
  });

  if (degradedDependencies().length === 0) {
    logDegradedModeCleared({ timestamp: new Date().toISOString() });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the current circuit state for a dependency.
 * Automatically advances OPEN → HALF_OPEN once the reset window has elapsed.
 */
export function getCircuitState(dep: DependencyName): CircuitState {
  const s = getState(dep);
  const cfg = CONFIGS[dep];

  if (s.state === 'OPEN' && s.openedAt !== null) {
    const elapsed = Date.now() - s.openedAt;
    if (elapsed >= cfg.resetWindowMs) {
      s.state = 'HALF_OPEN';
      circuitBreakerStateGauge.set({ dependency: dep, state: 'HALF_OPEN' }, 1);
      circuitBreakerStateGauge.set({ dependency: dep, state: 'OPEN' }, 0);
    }
  }

  return s.state;
}

/**
 * Returns the number of seconds until the breaker is eligible for a HALF_OPEN probe.
 * Returns 0 if already CLOSED or HALF_OPEN.
 */
export function retryAfterSeconds(dep: DependencyName): number {
  const s = getState(dep);
  const cfg = CONFIGS[dep];

  if (s.state !== 'OPEN' || s.openedAt === null) return 0;

  const elapsed = Date.now() - s.openedAt;
  const remaining = cfg.resetWindowMs - elapsed;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Returns true if the dependency's circuit breaker is in OPEN state (i.e. requests
 * should be rejected immediately with HTTP 503).
 */
export function isCircuitOpen(dep: DependencyName): boolean {
  return getCircuitState(dep) === 'OPEN';
}

/**
 * Returns the list of currently open/degraded dependencies.
 */
export function getDegradedDependencies(): DependencyName[] {
  return degradedDependencies();
}

/**
 * Returns a snapshot of the current state for all breakers.
 * Used by the /api/health endpoint.
 */
export function getCircuitBreakerHealth(): Record<DependencyName, { state: CircuitState; tripCount: number; retryAfterSeconds: number }> {
  const result = {} as Record<DependencyName, { state: CircuitState; tripCount: number; retryAfterSeconds: number }>;
  for (const dep of Object.keys(CONFIGS) as DependencyName[]) {
    result[dep] = {
      state: getCircuitState(dep),
      tripCount: getState(dep).tripCount,
      retryAfterSeconds: retryAfterSeconds(dep),
    };
  }
  return result;
}

/**
 * Record a successful call to a dependency.
 *
 * - HALF_OPEN + success → CLOSED (probe passed)
 * - CLOSED              → clear recent failure history
 */
export function recordSuccess(dep: DependencyName): void {
  const s = getState(dep);
  const currentState = getCircuitState(dep); // may advance OPEN → HALF_OPEN

  if (currentState === 'HALF_OPEN') {
    close(dep, s);
  } else if (currentState === 'CLOSED') {
    s.recentFailures = [];
  }
}

/**
 * Record a failure for a dependency.
 *
 * Failures are tracked in a rolling time window. Once the threshold is reached
 * the breaker trips to OPEN.
 *
 * - HALF_OPEN + failure → back to OPEN (probe failed, reset timer)
 * - CLOSED              → add to failure window; trip if threshold exceeded
 * - OPEN                → no-op (already tripped)
 */
export function recordFailure(dep: DependencyName, reason = 'upstream_error'): void {
  const s = getState(dep);
  const cfg = CONFIGS[dep];
  const currentState = getCircuitState(dep);

  if (currentState === 'OPEN') return; // already open, nothing to do

  if (currentState === 'HALF_OPEN') {
    // Probe failed — re-open the breaker and reset the timer
    s.recentFailures = [];
    trip(dep, s, cfg, `probe_failed: ${reason}`);
    return;
  }

  // CLOSED state — accumulate failures in rolling window
  const now = Date.now();
  const cutoff = now - cfg.windowMs;
  s.recentFailures = s.recentFailures.filter(t => t > cutoff);
  s.recentFailures.push(now);

  if (s.recentFailures.length >= cfg.failureThreshold) {
    trip(dep, s, cfg, reason);
  }
}

/**
 * Wraps an async operation with circuit breaker protection.
 *
 * - Throws `CircuitOpenError` immediately if the breaker is OPEN.
 * - Records success/failure on the breaker after the call completes.
 * - In HALF_OPEN state, allows exactly one probe through.
 */
export async function withCircuitBreaker<T>(
  dep: DependencyName,
  operation: () => Promise<T>,
  endpoint = 'unknown',
): Promise<T> {
  const currentState = getCircuitState(dep);

  if (currentState === 'OPEN') {
    const retryAfter = retryAfterSeconds(dep);
    circuitBreakerRejectTotal.inc({ dependency: dep });
    logRequestRejectedDegraded({
      dependency: dep,
      endpoint,
      timestamp: new Date().toISOString(),
    });
    throw new CircuitOpenError(dep, retryAfter);
  }

  try {
    const result = await operation();
    recordSuccess(dep);
    return result;
  } catch (err) {
    if (isUpstreamFailure(err)) {
      recordFailure(dep, extractReason(err));
    }
    throw err;
  }
}

// ── Error types ───────────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  readonly dependency: DependencyName;
  readonly retryAfterSeconds: number;

  constructor(dependency: DependencyName, retryAfterSeconds: number) {
    super(`Circuit breaker OPEN for dependency: ${dependency}`);
    this.name = 'CircuitOpenError';
    this.dependency = dependency;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isUpstreamFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // HTTP 5xx status codes
  const status = (err as unknown as { status?: number }).status;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;

  // Ollama-style "Ollama error 5xx" messages
  if (/\b5\d{2}\b/.test(err.message)) return true;

  // Network-level failures
  if (
    err.message.includes('ECONNREFUSED') ||
    err.message.includes('ECONNRESET') ||
    err.message.includes('ETIMEDOUT') ||
    err.message.includes('ENOTFOUND') ||
    err.message.includes('fetch failed') ||
    err.message.includes('network')
  ) return true;

  return false;
}

function extractReason(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown_error';
  const status = (err as unknown as { status?: number }).status;
  if (typeof status === 'number') return `http_${status}`;
  return err.message.slice(0, 80);
}

// ── Test helpers (only exported for unit tests) ───────────────────────────────

export function _resetAllBreakers(): void {
  for (const dep of Object.keys(CONFIGS) as DependencyName[]) {
    states.set(dep, { state: 'CLOSED', recentFailures: [], openedAt: null, tripCount: 0 });
  }
}
