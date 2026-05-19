import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock the logger and telemetry before any imports
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../telemetry/infrastructure.js', () => ({
  logCircuitBreakerTripped: vi.fn(),
  logCircuitBreakerReset: vi.fn(),
  logDegradedModeActive: vi.fn(),
  logDegradedModeCleared: vi.fn(),
  logRequestRejectedDegraded: vi.fn(),
}));

import {
  getState,
  recordSuccess,
  recordFailure,
  checkCircuit,
  retryAfterSeconds,
  getDegradedDependencies,
  _resetAllBreakers,
} from './circuit-breaker.js';
import {
  logCircuitBreakerTripped,
  logCircuitBreakerReset,
  logDegradedModeActive,
  logDegradedModeCleared,
  logRequestRejectedDegraded,
} from '../../telemetry/infrastructure.js';

beforeEach(() => {
  _resetAllBreakers();
  vi.clearAllMocks();
});

describe('circuit breaker — initial state', () => {
  it('starts CLOSED for all dependency types', () => {
    expect(getState('llm_provider')).toBe('CLOSED');
    expect(getState('github_api')).toBe('CLOSED');
    expect(getState('pgboss_queue')).toBe('CLOSED');
  });

  it('allows requests when CLOSED', () => {
    expect(checkCircuit('llm_provider', '/api/chat')).toEqual({ allowed: true });
  });
});

describe('circuit breaker — tripping (CLOSED → OPEN)', () => {
  it('trips llm_provider after 5 consecutive failures', () => {
    for (let i = 0; i < 5; i++) {
      expect(getState('llm_provider')).toBe('CLOSED');
      recordFailure('llm_provider', 'HTTP 500');
    }
    expect(getState('llm_provider')).toBe('OPEN');
  });

  it('trips github_api after 3 consecutive failures', () => {
    for (let i = 0; i < 3; i++) {
      recordFailure('github_api', 'HTTP 503');
    }
    expect(getState('github_api')).toBe('OPEN');
  });

  it('trips pgboss_queue after a single failure', () => {
    recordFailure('pgboss_queue', 'connection refused');
    expect(getState('pgboss_queue')).toBe('OPEN');
  });

  it('does NOT trip before threshold is reached', () => {
    recordFailure('github_api', 'HTTP 500');
    recordFailure('github_api', 'HTTP 500');
    // 2 < threshold of 3
    expect(getState('github_api')).toBe('CLOSED');
  });

  it('emits circuit_breaker_tripped telemetry on trip', () => {
    for (let i = 0; i < 5; i++) recordFailure('llm_provider', 'HTTP 500');
    expect(logCircuitBreakerTripped).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: 'llm_provider', tripCount: 1 }),
    );
  });

  it('emits degraded_mode_active telemetry on first trip', () => {
    for (let i = 0; i < 3; i++) recordFailure('github_api', 'HTTP 502');
    expect(logDegradedModeActive).toHaveBeenCalledWith(
      expect.objectContaining({ affectedDependencies: expect.arrayContaining(['github_api']) }),
    );
  });
});

describe('circuit breaker — OPEN state behaviour', () => {
  it('rejects requests when OPEN', () => {
    recordFailure('pgboss_queue', 'down');
    const result = checkCircuit('pgboss_queue', '/api/tickets');
    expect(result).toMatchObject({ allowed: false });
  });

  it('includes a non-zero retryAfter when OPEN', () => {
    recordFailure('pgboss_queue', 'down');
    const result = checkCircuit('pgboss_queue', '/api/tickets');
    expect(result).toMatchObject({ allowed: false });
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThan(0);
    }
  });

  it('emits request_rejected_degraded on each rejected check', () => {
    recordFailure('pgboss_queue', 'down');
    checkCircuit('pgboss_queue', '/api/tickets');
    expect(logRequestRejectedDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: 'pgboss_queue', endpoint: '/api/tickets' }),
    );
  });

  it('does not record further failures when already OPEN', () => {
    recordFailure('pgboss_queue', 'down');
    vi.mocked(logCircuitBreakerTripped).mockClear();
    recordFailure('pgboss_queue', 'still down');
    // Should not fire again
    expect(logCircuitBreakerTripped).not.toHaveBeenCalled();
  });
});

describe('circuit breaker — OPEN → HALF_OPEN transition', () => {
  it('transitions to HALF_OPEN once the reset window elapses', () => {
    vi.useFakeTimers();
    recordFailure('pgboss_queue', 'down');
    expect(getState('pgboss_queue')).toBe('OPEN');

    // Advance past the 30 s reset window
    vi.advanceTimersByTime(31_000);
    expect(getState('pgboss_queue')).toBe('HALF_OPEN');
    vi.useRealTimers();
  });

  it('allows a probe request in HALF_OPEN state', () => {
    vi.useFakeTimers();
    recordFailure('pgboss_queue', 'down');
    vi.advanceTimersByTime(31_000);
    expect(checkCircuit('pgboss_queue', '/probe')).toEqual({ allowed: true });
    vi.useRealTimers();
  });
});

describe('circuit breaker — HALF_OPEN → CLOSED recovery', () => {
  it('returns to CLOSED after a successful probe', () => {
    vi.useFakeTimers();
    recordFailure('pgboss_queue', 'down');
    vi.advanceTimersByTime(31_000);
    // Probe succeeds
    recordSuccess('pgboss_queue');
    expect(getState('pgboss_queue')).toBe('CLOSED');
    vi.useRealTimers();
  });

  it('emits circuit_breaker_reset telemetry on recovery', () => {
    vi.useFakeTimers();
    recordFailure('pgboss_queue', 'down');
    vi.advanceTimersByTime(31_000);
    recordSuccess('pgboss_queue');
    expect(logCircuitBreakerReset).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: 'pgboss_queue' }),
    );
    vi.useRealTimers();
  });

  it('emits degraded_mode_cleared when the last OPEN breaker recovers', () => {
    vi.useFakeTimers();
    recordFailure('pgboss_queue', 'down');
    vi.advanceTimersByTime(31_000);
    recordSuccess('pgboss_queue');
    expect(logDegradedModeCleared).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does NOT emit degraded_mode_cleared when other breakers remain OPEN', () => {
    vi.useFakeTimers();
    // Trip both
    recordFailure('pgboss_queue', 'down');
    for (let i = 0; i < 3; i++) recordFailure('github_api', 'HTTP 503');

    // Advance only past pgboss reset window, not github (120 s)
    vi.advanceTimersByTime(31_000);
    recordSuccess('pgboss_queue');

    expect(logDegradedModeCleared).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('getDegradedDependencies()', () => {
  it('returns empty list when all breakers are CLOSED', () => {
    const { dependencies } = getDegradedDependencies();
    expect(dependencies).toHaveLength(0);
  });

  it('lists all OPEN dependencies', () => {
    recordFailure('pgboss_queue', 'down');
    for (let i = 0; i < 3; i++) recordFailure('github_api', 'HTTP 503');

    const { dependencies } = getDegradedDependencies();
    expect(dependencies).toContain('pgboss_queue');
    expect(dependencies).toContain('github_api');
    expect(dependencies).not.toContain('llm_provider');
  });

  it('reports the largest retryAfter across open breakers', () => {
    // pgboss resets in 30 s, github in 120 s
    recordFailure('pgboss_queue', 'down');
    for (let i = 0; i < 3; i++) recordFailure('github_api', 'HTTP 503');

    const { maxRetryAfter } = getDegradedDependencies();
    // github reset window is 120 s so maxRetryAfter should be close to that
    expect(maxRetryAfter).toBeGreaterThanOrEqual(100);
  });
});

describe('retryAfterSeconds()', () => {
  it('returns 0 when the breaker is CLOSED', () => {
    expect(retryAfterSeconds('llm_provider')).toBe(0);
  });

  it('returns a positive value when the breaker is OPEN', () => {
    recordFailure('pgboss_queue', 'down');
    expect(retryAfterSeconds('pgboss_queue')).toBeGreaterThan(0);
  });
});
