import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  recordSuccess,
  recordFailure,
  isOpen,
  retryAfterSeconds,
  getOpenDependencies,
  isAnyOpen,
  getBreakerStates,
  _resetAllBreakers,
} from '../dependency-circuit-breaker.js';

// Freeze time so timing assertions are deterministic
beforeEach(() => {
  vi.useFakeTimers();
  _resetAllBreakers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetAllBreakers();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Initial state
// ─────────────────────────────────────────────────────────────────────────────

describe('initial state', () => {
  it('all breakers start CLOSED', () => {
    const states = getBreakerStates();
    expect(states.github_api).toBe('CLOSED');
    expect(states.queue_database).toBe('CLOSED');
    expect(states.llm_provider).toBe('CLOSED');
  });

  it('isAnyOpen returns false with no failures', () => {
    expect(isAnyOpen()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GitHub API — 3 consecutive failures within 60 s trips the breaker
// ─────────────────────────────────────────────────────────────────────────────

describe('github_api circuit breaker', () => {
  it('does not open after 2 consecutive failures', () => {
    recordFailure('github_api');
    recordFailure('github_api');
    expect(isOpen('github_api')).toBe(false);
    expect(getBreakerStates().github_api).toBe('CLOSED');
  });

  it('trips on 3rd consecutive failure within window', () => {
    recordFailure('github_api');
    recordFailure('github_api');
    recordFailure('github_api');
    expect(isOpen('github_api')).toBe(true);
    expect(getBreakerStates().github_api).toBe('OPEN');
  });

  it('retryAfterSeconds is positive and ≤ 120 after trip', () => {
    recordFailure('github_api');
    recordFailure('github_api');
    recordFailure('github_api');
    const secs = retryAfterSeconds('github_api');
    expect(secs).toBeGreaterThan(0);
    expect(secs).toBeLessThanOrEqual(120);
  });

  it('resets failure count when window expires before threshold is reached', () => {
    recordFailure('github_api');
    recordFailure('github_api');
    // Advance time past the 60 s window
    vi.advanceTimersByTime(61_000);
    // New failure window — should not trip until 3 more failures
    recordFailure('github_api');
    expect(isOpen('github_api')).toBe(false);
  });

  it('isOpen returns false for untripped breaker', () => {
    expect(isOpen('github_api')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. queue_database — trips on 1st failure
// ─────────────────────────────────────────────────────────────────────────────

describe('queue_database circuit breaker', () => {
  it('trips immediately on first failure', () => {
    recordFailure('queue_database');
    expect(isOpen('queue_database')).toBe(true);
  });

  it('retryAfterSeconds is positive and ≤ 30 after trip', () => {
    recordFailure('queue_database');
    const secs = retryAfterSeconds('queue_database');
    expect(secs).toBeGreaterThan(0);
    expect(secs).toBeLessThanOrEqual(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. llm_provider — 5 consecutive failures within 120 s
// ─────────────────────────────────────────────────────────────────────────────

describe('llm_provider circuit breaker', () => {
  it('does not trip after 4 failures', () => {
    for (let i = 0; i < 4; i++) recordFailure('llm_provider');
    expect(isOpen('llm_provider')).toBe(false);
  });

  it('trips on 5th consecutive failure', () => {
    for (let i = 0; i < 5; i++) recordFailure('llm_provider');
    expect(isOpen('llm_provider')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. HALF_OPEN probe and recovery path
// ─────────────────────────────────────────────────────────────────────────────

describe('HALF_OPEN → CLOSED recovery', () => {
  it('transitions to HALF_OPEN after reset window elapses', () => {
    recordFailure('queue_database');
    expect(getBreakerStates().queue_database).toBe('OPEN');
    // Advance past 30 s reset window
    vi.advanceTimersByTime(31_000);
    // isOpen triggers the OPEN → HALF_OPEN transition
    const open = isOpen('queue_database');
    expect(open).toBe(false); // HALF_OPEN lets one probe through
    expect(getBreakerStates().queue_database).toBe('HALF_OPEN');
  });

  it('closes on successful probe after HALF_OPEN', () => {
    recordFailure('queue_database');
    vi.advanceTimersByTime(31_000);
    isOpen('queue_database'); // triggers HALF_OPEN transition
    recordSuccess('queue_database');
    expect(getBreakerStates().queue_database).toBe('CLOSED');
    expect(isAnyOpen()).toBe(false);
  });

  it('re-opens on failed probe in HALF_OPEN state', () => {
    recordFailure('queue_database');
    vi.advanceTimersByTime(31_000);
    isOpen('queue_database'); // HALF_OPEN
    recordFailure('queue_database', 'probe_failed');
    expect(getBreakerStates().queue_database).toBe('OPEN');
  });

  it('retryAfterSeconds returns 0 when CLOSED', () => {
    expect(retryAfterSeconds('queue_database')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. getOpenDependencies & isAnyOpen
// ─────────────────────────────────────────────────────────────────────────────

describe('getOpenDependencies and isAnyOpen', () => {
  it('returns only tripped breakers', () => {
    recordFailure('queue_database');
    recordFailure('github_api');
    recordFailure('github_api');
    // Only queue_database tripped (threshold 1)
    expect(getOpenDependencies()).toEqual(['queue_database']);
    expect(isAnyOpen()).toBe(true);
  });

  it('returns empty array when all closed', () => {
    expect(getOpenDependencies()).toEqual([]);
    expect(isAnyOpen()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PRD § 4.1 scenario: GitHub API outage simulation
// ─────────────────────────────────────────────────────────────────────────────

describe('PRD §4.1 — GitHub API outage simulation', () => {
  it('trips after 3 consecutive 5xx, allows recovery after reset window', () => {
    // Step 1: 3 failures trip the breaker
    recordFailure('github_api', '5xx');
    recordFailure('github_api', '5xx');
    recordFailure('github_api', '5xx');
    expect(isOpen('github_api')).toBe(true);
    expect(isAnyOpen()).toBe(true);
    expect(getOpenDependencies()).toContain('github_api');
    expect(retryAfterSeconds('github_api')).toBeGreaterThan(0);

    // Step 2: advance past 120 s reset window → HALF_OPEN probe allowed
    vi.advanceTimersByTime(121_000);
    expect(isOpen('github_api')).toBe(false); // probe through
    expect(getBreakerStates().github_api).toBe('HALF_OPEN');

    // Step 3: probe succeeds → CLOSED
    recordSuccess('github_api');
    expect(getBreakerStates().github_api).toBe('CLOSED');
    expect(isAnyOpen()).toBe(false);
  });
});
