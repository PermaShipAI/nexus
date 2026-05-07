import '../../../src/tests/env.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock telemetry to avoid prom-client side-effects in tests
vi.mock('../../../agents/telemetry/logger.js', () => ({
  logCircuitBreakerTripped: vi.fn(),
  logCircuitBreakerReset: vi.fn(),
  logDegradedModeActive: vi.fn(),
  logDegradedModeCleared: vi.fn(),
  logRequestRejectedDegraded: vi.fn(),
}));

vi.mock('../../telemetry/prometheus.js', () => ({
  circuitBreakerStateGauge: { set: vi.fn() },
  circuitBreakerTripTotal: { inc: vi.fn() },
  circuitBreakerRejectTotal: { inc: vi.fn() },
}));

import {
  getCircuitState,
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  retryAfterSeconds,
  withCircuitBreaker,
  getCircuitBreakerHealth,
  getDegradedDependencies,
  CircuitOpenError,
  _resetAllBreakers,
} from '../circuit-breaker.js';

import {
  logCircuitBreakerTripped,
  logCircuitBreakerReset,
  logDegradedModeActive,
  logDegradedModeCleared,
  logRequestRejectedDegraded,
} from '../../../agents/telemetry/logger.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function make5xxError(status = 503): Error {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('circuit-breaker module', () => {
  beforeEach(() => {
    _resetAllBreakers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('all breakers start CLOSED', () => {
      expect(getCircuitState('github_api')).toBe('CLOSED');
      expect(getCircuitState('pg_boss')).toBe('CLOSED');
      expect(getCircuitState('llm_provider')).toBe('CLOSED');
    });

    it('isCircuitOpen returns false for all breakers initially', () => {
      expect(isCircuitOpen('github_api')).toBe(false);
      expect(isCircuitOpen('pg_boss')).toBe(false);
      expect(isCircuitOpen('llm_provider')).toBe(false);
    });

    it('getDegradedDependencies returns empty array', () => {
      expect(getDegradedDependencies()).toEqual([]);
    });
  });

  // ── github_api: 3 consecutive failures within 60 s ────────────────────────

  describe('github_api breaker (threshold=3, window=60s)', () => {
    it('does not trip after 2 failures', () => {
      recordFailure('github_api', 'http_503');
      recordFailure('github_api', 'http_503');
      expect(getCircuitState('github_api')).toBe('CLOSED');
      expect(logCircuitBreakerTripped).not.toHaveBeenCalled();
    });

    it('trips to OPEN after 3 consecutive failures', () => {
      recordFailure('github_api', 'http_503');
      recordFailure('github_api', 'http_503');
      recordFailure('github_api', 'http_503');

      expect(getCircuitState('github_api')).toBe('OPEN');
      expect(isCircuitOpen('github_api')).toBe(true);
      expect(logCircuitBreakerTripped).toHaveBeenCalledWith(
        expect.objectContaining({ dependency: 'github_api', trip_count: 1 }),
      );
    });

    it('emits degraded_mode_active when first breaker trips', () => {
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      expect(logDegradedModeActive).toHaveBeenCalledWith(
        expect.objectContaining({ affected_dependencies: ['github_api'] }),
      );
    });

    it('failures outside the 60 s window do not count toward threshold', () => {
      vi.useFakeTimers();

      recordFailure('github_api', 'http_503'); // t=0
      recordFailure('github_api', 'http_503'); // t=0

      vi.advanceTimersByTime(61_000); // past window

      recordFailure('github_api', 'http_503'); // t=61s – window resets
      // Only 1 failure in the fresh window, should still be CLOSED
      expect(getCircuitState('github_api')).toBe('CLOSED');
    });

    it('retryAfterSeconds returns ~120 immediately after trip', () => {
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      const secs = retryAfterSeconds('github_api');
      expect(secs).toBeGreaterThan(0);
      expect(secs).toBeLessThanOrEqual(120);
    });
  });

  // ── pg_boss: trips on first failure ──────────────────────────────────────

  describe('pg_boss breaker (threshold=1)', () => {
    it('trips immediately on first failure', () => {
      recordFailure('pg_boss', 'connection_refused');
      expect(getCircuitState('pg_boss')).toBe('OPEN');
      expect(logCircuitBreakerTripped).toHaveBeenCalledWith(
        expect.objectContaining({ dependency: 'pg_boss' }),
      );
    });
  });

  // ── llm_provider: 5 consecutive failures within 120 s ────────────────────

  describe('llm_provider breaker (threshold=5, window=120s)', () => {
    it('trips to OPEN after 5 consecutive failures', () => {
      for (let i = 0; i < 5; i++) recordFailure('llm_provider', 'http_500');
      expect(getCircuitState('llm_provider')).toBe('OPEN');
    });

    it('does not trip after 4 failures', () => {
      for (let i = 0; i < 4; i++) recordFailure('llm_provider', 'http_500');
      expect(getCircuitState('llm_provider')).toBe('CLOSED');
    });
  });

  // ── HALF_OPEN / recovery ──────────────────────────────────────────────────

  describe('HALF_OPEN probe and recovery', () => {
    it('transitions OPEN → HALF_OPEN after reset window elapses', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      expect(getCircuitState('github_api')).toBe('OPEN');

      vi.advanceTimersByTime(121_000); // past 120 s reset window
      expect(getCircuitState('github_api')).toBe('HALF_OPEN');
    });

    it('transitions HALF_OPEN → CLOSED on successful probe', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      vi.advanceTimersByTime(121_000);
      expect(getCircuitState('github_api')).toBe('HALF_OPEN');

      recordSuccess('github_api');
      expect(getCircuitState('github_api')).toBe('CLOSED');
      expect(logCircuitBreakerReset).toHaveBeenCalledWith(
        expect.objectContaining({ dependency: 'github_api' }),
      );
    });

    it('emits degraded_mode_cleared when last breaker closes', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      vi.advanceTimersByTime(121_000);
      recordSuccess('github_api');
      expect(logDegradedModeCleared).toHaveBeenCalled();
    });

    it('transitions HALF_OPEN → OPEN on failed probe (resets timer)', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      vi.advanceTimersByTime(121_000);
      expect(getCircuitState('github_api')).toBe('HALF_OPEN');

      recordFailure('github_api', 'probe_failed');
      expect(getCircuitState('github_api')).toBe('OPEN');
    });
  });

  // ── withCircuitBreaker ────────────────────────────────────────────────────

  describe('withCircuitBreaker()', () => {
    it('executes the operation when CLOSED', async () => {
      const op = vi.fn().mockResolvedValue('data');
      const result = await withCircuitBreaker('github_api', op, '/repos');
      expect(result).toBe('data');
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('throws CircuitOpenError when OPEN (GitHub outage simulation)', async () => {
      // Simulate 3 consecutive 5xx from GitHub adapter
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      expect(isCircuitOpen('github_api')).toBe(true);

      const op = vi.fn().mockResolvedValue('should-not-run');
      await expect(withCircuitBreaker('github_api', op, '/api/tickets')).rejects.toThrow(
        CircuitOpenError,
      );
      expect(op).not.toHaveBeenCalled();
    });

    it('CircuitOpenError includes retryAfterSeconds and dependency name', async () => {
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');

      try {
        await withCircuitBreaker('github_api', vi.fn(), '/endpoint');
        expect.fail('expected CircuitOpenError');
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitOpenError);
        const cbErr = err as CircuitOpenError;
        expect(cbErr.dependency).toBe('github_api');
        expect(cbErr.retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it('emits request_rejected_degraded telemetry when rejecting', async () => {
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');

      await expect(
        withCircuitBreaker('github_api', vi.fn(), '/api/tickets'),
      ).rejects.toThrow(CircuitOpenError);

      expect(logRequestRejectedDegraded).toHaveBeenCalledWith(
        expect.objectContaining({ dependency: 'github_api', endpoint: '/api/tickets' }),
      );
    });

    it('records failure and trips breaker when operation throws 5xx', async () => {
      const op = vi.fn()
        .mockRejectedValue(make5xxError(503));

      // First 2 calls fail but breaker should still be CLOSED
      for (let i = 0; i < 2; i++) {
        await expect(withCircuitBreaker('github_api', op, '/test')).rejects.toThrow();
      }
      expect(getCircuitState('github_api')).toBe('CLOSED');

      // Third failure trips the breaker
      await expect(withCircuitBreaker('github_api', op, '/test')).rejects.toThrow();
      expect(getCircuitState('github_api')).toBe('OPEN');
    });

    it('records success and clears failure window on successful call', async () => {
      recordFailure('github_api', 'http_503');
      recordFailure('github_api', 'http_503');

      const op = vi.fn().mockResolvedValue('ok');
      await withCircuitBreaker('github_api', op, '/test');
      // After a success the failure window resets; two more failures should not trip
      recordFailure('github_api', 'http_503');
      recordFailure('github_api', 'http_503');
      expect(getCircuitState('github_api')).toBe('CLOSED');
    });

    it('does not trip breaker for non-5xx errors', async () => {
      const userError = new Error('Bad Request');
      (userError as unknown as { status: number }).status = 400;
      const op = vi.fn().mockRejectedValue(userError);

      for (let i = 0; i < 5; i++) {
        await expect(withCircuitBreaker('github_api', op, '/test')).rejects.toThrow();
      }
      expect(getCircuitState('github_api')).toBe('CLOSED');
    });
  });

  // ── pg_boss unavailability — synchronous fallback prohibited ─────────────

  describe('pg_boss unavailability (PRD §3.3)', () => {
    it('trips immediately on first failure', async () => {
      recordFailure('pg_boss', 'connection_refused');
      expect(isCircuitOpen('pg_boss')).toBe(true);
    });

    it('rejects all subsequent calls with CircuitOpenError — no fallback', async () => {
      recordFailure('pg_boss', 'connection_refused');

      const op = vi.fn().mockResolvedValue('queued');
      await expect(withCircuitBreaker('pg_boss', op, '/api/tickets')).rejects.toThrow(
        CircuitOpenError,
      );
      // Critically: the operation was never called — no in-memory fallback
      expect(op).not.toHaveBeenCalled();
    });
  });

  // ── Retry-After header compliance ─────────────────────────────────────────

  describe('Retry-After header compliance (PRD §3.2)', () => {
    it('retryAfterSeconds is non-zero when breaker is OPEN', () => {
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      expect(retryAfterSeconds('github_api')).toBeGreaterThan(0);
    });

    it('retryAfterSeconds is 0 when breaker is CLOSED', () => {
      expect(retryAfterSeconds('github_api')).toBe(0);
    });
  });

  // ── Recovery path ─────────────────────────────────────────────────────────

  describe('full recovery path (PRD §4.1 scenario 3)', () => {
    it('OPEN → HALF_OPEN → CLOSED after outage clears', () => {
      vi.useFakeTimers();

      // Trip the breaker
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      expect(getCircuitState('github_api')).toBe('OPEN');
      expect(logCircuitBreakerTripped).toHaveBeenCalled();

      // Advance past reset window
      vi.advanceTimersByTime(121_000);
      expect(getCircuitState('github_api')).toBe('HALF_OPEN');

      // Successful probe
      recordSuccess('github_api');
      expect(getCircuitState('github_api')).toBe('CLOSED');
      expect(logCircuitBreakerReset).toHaveBeenCalledWith(
        expect.objectContaining({ dependency: 'github_api' }),
      );
      expect(logDegradedModeCleared).toHaveBeenCalled();
    });
  });

  // ── getCircuitBreakerHealth ───────────────────────────────────────────────

  describe('getCircuitBreakerHealth()', () => {
    it('returns state snapshot for all three dependencies', () => {
      const health = getCircuitBreakerHealth();
      expect(health).toHaveProperty('github_api');
      expect(health).toHaveProperty('pg_boss');
      expect(health).toHaveProperty('llm_provider');
    });

    it('reflects OPEN state after tripping', () => {
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      const health = getCircuitBreakerHealth();
      expect(health.github_api.state).toBe('OPEN');
      expect(health.github_api.tripCount).toBe(1);
      expect(health.github_api.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  // ── All five PRD telemetry events ─────────────────────────────────────────

  describe('telemetry events (PRD §3.4)', () => {
    it('emits circuit_breaker_tripped with required fields', () => {
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      expect(logCircuitBreakerTripped).toHaveBeenCalledWith(
        expect.objectContaining({
          dependency: 'github_api',
          reason: expect.any(String),
          trip_count: expect.any(Number),
          timestamp: expect.any(String),
        }),
      );
    });

    it('emits circuit_breaker_reset with required fields', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      vi.advanceTimersByTime(121_000);
      recordSuccess('github_api');
      expect(logCircuitBreakerReset).toHaveBeenCalledWith(
        expect.objectContaining({
          dependency: 'github_api',
          downtime_seconds: expect.any(Number),
          timestamp: expect.any(String),
        }),
      );
    });

    it('emits degraded_mode_active with required fields', () => {
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      expect(logDegradedModeActive).toHaveBeenCalledWith(
        expect.objectContaining({
          affected_dependencies: expect.arrayContaining(['github_api']),
          timestamp: expect.any(String),
        }),
      );
    });

    it('emits degraded_mode_cleared when all breakers close', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      vi.advanceTimersByTime(121_000);
      recordSuccess('github_api');
      expect(logDegradedModeCleared).toHaveBeenCalledWith(
        expect.objectContaining({ timestamp: expect.any(String) }),
      );
    });

    it('emits request_rejected_degraded with required fields', async () => {
      for (let i = 0; i < 3; i++) recordFailure('github_api', 'http_503');
      await expect(
        withCircuitBreaker('github_api', vi.fn(), '/api/tickets'),
      ).rejects.toThrow(CircuitOpenError);

      expect(logRequestRejectedDegraded).toHaveBeenCalledWith(
        expect.objectContaining({
          dependency: 'github_api',
          endpoint: '/api/tickets',
          timestamp: expect.any(String),
        }),
      );
    });
  });
});
