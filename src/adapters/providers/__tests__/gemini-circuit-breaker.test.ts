import '../../../tests/env.js';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock prom-client so tests run without the real dependency
vi.mock('prom-client', () => {
  class Registry {
    contentType = 'text/plain';
    metrics = vi.fn(async () => '');
    register = vi.fn();
  }

  class Counter {
    inc = vi.fn();
  }

  class Histogram {
    observe = vi.fn();
  }

  const collectDefaultMetrics = vi.fn();

  return { Registry, Counter, Histogram, collectDefaultMetrics };
});

// Mock logger to suppress output during tests
vi.mock('../../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { geminiCircuitBreaker, GeminiCircuitOpenError } from '../gemini-circuit-breaker.js';
import { geminiCbTransitionsTotal } from '../../../telemetry/prometheus.js';

// Helper to create retriable errors (HTTP 503, 429)
const retriableError = (status: number, msg = `HTTP ${status}`) =>
  Object.assign(new Error(msg), { status });

// Helper to create non-retriable errors (HTTP 400)
const nonRetriableError = (status: number, msg = `HTTP ${status}`) =>
  Object.assign(new Error(msg), { status });

describe('GeminiCircuitBreaker', () => {
  beforeEach(() => {
    geminiCircuitBreaker.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. CLOSED → OPEN after tripThreshold (3) consecutive retriable failures
  // ─────────────────────────────────────────────────────────────────────────
  describe('CLOSED → OPEN transition', () => {
    it('opens after tripThreshold (3) consecutive 503 failures', () => {
      expect(geminiCircuitBreaker.isOpen()).toBe(false);
      expect(geminiCircuitBreaker.getState()).toBe('CLOSED');

      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.isOpen()).toBe(false);

      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.isOpen()).toBe(false);

      // Third failure — should trip the breaker
      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.isOpen()).toBe(true);
      expect(geminiCircuitBreaker.getState()).toBe('OPEN');
    });

    it('opens after tripThreshold (3) consecutive 429 failures', () => {
      geminiCircuitBreaker.recordFailure(retriableError(429));
      geminiCircuitBreaker.recordFailure(retriableError(429));
      geminiCircuitBreaker.recordFailure(retriableError(429));

      expect(geminiCircuitBreaker.isOpen()).toBe(true);
    });

    it('does NOT open before reaching tripThreshold', () => {
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));

      expect(geminiCircuitBreaker.isOpen()).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Non-retriable errors do NOT increment counter and do NOT open breaker
  // ─────────────────────────────────────────────────────────────────────────
  describe('non-retriable errors', () => {
    it('status 400 does not increment failure counter or open the breaker', () => {
      // Even many 400 errors should not open the breaker
      for (let i = 0; i < 10; i++) {
        geminiCircuitBreaker.recordFailure(nonRetriableError(400));
      }
      expect(geminiCircuitBreaker.isOpen()).toBe(false);
      expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
    });

    it('status 401 does not open the breaker', () => {
      for (let i = 0; i < 5; i++) {
        geminiCircuitBreaker.recordFailure(nonRetriableError(401));
      }
      expect(geminiCircuitBreaker.isOpen()).toBe(false);
    });

    it('status 403 does not open the breaker', () => {
      for (let i = 0; i < 5; i++) {
        geminiCircuitBreaker.recordFailure(nonRetriableError(403));
      }
      expect(geminiCircuitBreaker.isOpen()).toBe(false);
    });

    it('non-retriable errors do not count toward tripThreshold alongside retriable ones', () => {
      // 2 retriable failures (below threshold)
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));

      // Several non-retriable errors — should not trip the breaker
      geminiCircuitBreaker.recordFailure(nonRetriableError(400));
      geminiCircuitBreaker.recordFailure(nonRetriableError(400));
      geminiCircuitBreaker.recordFailure(nonRetriableError(400));

      expect(geminiCircuitBreaker.isOpen()).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. isOpen() returns false after LLM_CB_RESET_WINDOW_MS elapses (HALF_OPEN)
  // ─────────────────────────────────────────────────────────────────────────
  describe('HALF_OPEN probe window after reset window elapses', () => {
    it('isOpen() returns false (HALF_OPEN) after resetWindowMs elapses', () => {
      vi.useFakeTimers();

      // Trip the breaker
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.isOpen()).toBe(true);
      expect(geminiCircuitBreaker.getState()).toBe('OPEN');

      // Advance past the default reset window (60_000 ms)
      vi.advanceTimersByTime(60_001);

      expect(geminiCircuitBreaker.isOpen()).toBe(false);
      expect(geminiCircuitBreaker.getState()).toBe('HALF_OPEN');
    });

    it('remains OPEN just before the reset window elapses', () => {
      vi.useFakeTimers();

      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));

      // Just under reset window
      vi.advanceTimersByTime(59_999);
      expect(geminiCircuitBreaker.isOpen()).toBe(true);
      expect(geminiCircuitBreaker.getState()).toBe('OPEN');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. HALF_OPEN probe success → CLOSED
  // ─────────────────────────────────────────────────────────────────────────
  describe('HALF_OPEN probe success', () => {
    it('transitions HALF_OPEN → CLOSED on recordSuccess and isOpen() returns false', () => {
      vi.useFakeTimers();

      // Trip the breaker
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.getState()).toBe('OPEN');

      // Advance past reset window to enter HALF_OPEN
      vi.advanceTimersByTime(60_001);
      expect(geminiCircuitBreaker.getState()).toBe('HALF_OPEN');

      // Successful probe
      geminiCircuitBreaker.recordSuccess();

      expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
      expect(geminiCircuitBreaker.isOpen()).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. HALF_OPEN probe failure → OPEN (reset open timestamp)
  // ─────────────────────────────────────────────────────────────────────────
  describe('HALF_OPEN probe failure', () => {
    it('transitions HALF_OPEN → OPEN on recordFailure and resets open timestamp', () => {
      vi.useFakeTimers();

      // Trip the breaker
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));

      // Advance past reset window to HALF_OPEN
      vi.advanceTimersByTime(60_001);
      expect(geminiCircuitBreaker.getState()).toBe('HALF_OPEN');

      // Probe fails with retriable error
      geminiCircuitBreaker.recordFailure(retriableError(503));

      // Should be back to OPEN
      expect(geminiCircuitBreaker.getState()).toBe('OPEN');
      expect(geminiCircuitBreaker.isOpen()).toBe(true);

      // The open timestamp should have been reset — advancing another full window should allow HALF_OPEN again
      vi.advanceTimersByTime(60_001);
      expect(geminiCircuitBreaker.getState()).toBe('HALF_OPEN');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Success in CLOSED resets counter without state change
  // ─────────────────────────────────────────────────────────────────────────
  describe('success in CLOSED state', () => {
    it('resets consecutive failure counter without changing CLOSED state', () => {
      // 2 retriable failures — just under threshold
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.getState()).toBe('CLOSED');

      // A success should reset the counter
      geminiCircuitBreaker.recordSuccess();
      expect(geminiCircuitBreaker.getState()).toBe('CLOSED');

      // Now 2 more failures should not open the breaker (counter was reset)
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.isOpen()).toBe(false);

      // But a 3rd failure after reset should trip it
      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.isOpen()).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. reset() restores CLOSED state
  // ─────────────────────────────────────────────────────────────────────────
  describe('reset()', () => {
    it('restores CLOSED state from OPEN', () => {
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.isOpen()).toBe(true);

      geminiCircuitBreaker.reset();

      expect(geminiCircuitBreaker.isOpen()).toBe(false);
      expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
    });

    it('allows retriggering after reset', () => {
      // Trip, reset, then trip again
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.isOpen()).toBe(true);

      geminiCircuitBreaker.reset();
      expect(geminiCircuitBreaker.isOpen()).toBe(false);

      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      expect(geminiCircuitBreaker.isOpen()).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Prometheus counter geminiCbTransitionsTotal.inc is called on transitions
  // ─────────────────────────────────────────────────────────────────────────
  describe('Prometheus metrics', () => {
    it('calls geminiCbTransitionsTotal.inc when transitioning CLOSED → OPEN', () => {
      const incSpy = vi.spyOn(geminiCbTransitionsTotal, 'inc');

      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));

      expect(incSpy).toHaveBeenCalledWith({ from_state: 'CLOSED', to_state: 'OPEN' });
    });

    it('calls geminiCbTransitionsTotal.inc when transitioning HALF_OPEN → CLOSED on probe success', () => {
      vi.useFakeTimers();
      const incSpy = vi.spyOn(geminiCbTransitionsTotal, 'inc');

      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));

      vi.advanceTimersByTime(60_001);
      expect(geminiCircuitBreaker.getState()).toBe('HALF_OPEN');

      incSpy.mockClear();
      geminiCircuitBreaker.recordSuccess();

      expect(incSpy).toHaveBeenCalledWith({ from_state: 'HALF_OPEN', to_state: 'CLOSED' });
    });

    it('calls geminiCbTransitionsTotal.inc when transitioning HALF_OPEN → OPEN on probe failure', () => {
      vi.useFakeTimers();
      const incSpy = vi.spyOn(geminiCbTransitionsTotal, 'inc');

      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));
      geminiCircuitBreaker.recordFailure(retriableError(503));

      vi.advanceTimersByTime(60_001);
      expect(geminiCircuitBreaker.getState()).toBe('HALF_OPEN');

      // Clear spy after CLOSED→OPEN transition
      incSpy.mockClear();

      geminiCircuitBreaker.recordFailure(retriableError(503));

      // HALF_OPEN → OPEN calls _transition since prev !== 'OPEN'
      expect(incSpy).toHaveBeenCalledWith({ from_state: 'HALF_OPEN', to_state: 'OPEN' });
    });

    it('does NOT call inc on non-retriable errors', () => {
      const incSpy = vi.spyOn(geminiCbTransitionsTotal, 'inc');

      for (let i = 0; i < 10; i++) {
        geminiCircuitBreaker.recordFailure(nonRetriableError(400));
      }

      expect(incSpy).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GeminiCircuitOpenError
  // ─────────────────────────────────────────────────────────────────────────
  describe('GeminiCircuitOpenError', () => {
    it('is an instance of Error with correct name', () => {
      const err = new GeminiCircuitOpenError();
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GeminiCircuitOpenError');
      expect(err.message).toContain('circuit breaker is open');
    });
  });
});
