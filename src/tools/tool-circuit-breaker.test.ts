import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  recordTrip,
  isPersonaPaused,
  _resetForTesting,
  CONFLICT_WINDOW_MS,
  MAX_TRIPS_BEFORE_HALT,
} from './tool-circuit-breaker.js';

vi.mock('../telemetry/index.js', () => ({
  logGuardrailEvent: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

describe('tool-circuit-breaker', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a single trip without halting', () => {
    const result = recordTrip('agent-1', 'org-1', 'create_ticket_proposal', 409);
    expect(result.shouldHalt).toBe(false);
    expect(isPersonaPaused('agent-1')).toBe(false);
  });

  it('does not halt after 4 trips', () => {
    for (let i = 0; i < MAX_TRIPS_BEFORE_HALT - 1; i++) {
      const result = recordTrip('agent-2', 'org-1', 'create_ticket_proposal', 409);
      expect(result.shouldHalt).toBe(false);
    }
    expect(isPersonaPaused('agent-2')).toBe(false);
  });

  it('halts after 5 trips within the window', () => {
    let lastResult = { shouldHalt: false };
    for (let i = 0; i < MAX_TRIPS_BEFORE_HALT; i++) {
      lastResult = recordTrip('agent-3', 'org-1', 'create_ticket_proposal', 409);
    }
    expect(lastResult.shouldHalt).toBe(true);
    expect(isPersonaPaused('agent-3')).toBe(true);
  });

  it('expires trips outside the window', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    for (let i = 0; i < MAX_TRIPS_BEFORE_HALT; i++) {
      recordTrip('agent-4', 'org-1', 'create_ticket_proposal', 409);
    }
    expect(isPersonaPaused('agent-4')).toBe(true);

    // Advance time past the conflict window
    vi.setSystemTime(now + CONFLICT_WINDOW_MS + 1);
    expect(isPersonaPaused('agent-4')).toBe(false);
  });

  it('isolates trips between different agents', () => {
    for (let i = 0; i < MAX_TRIPS_BEFORE_HALT; i++) {
      recordTrip('agent-5', 'org-1', 'create_ticket_proposal', 409);
    }
    expect(isPersonaPaused('agent-5')).toBe(true);
    expect(isPersonaPaused('agent-6')).toBe(false);
  });

  it('_resetForTesting clears all state', () => {
    for (let i = 0; i < MAX_TRIPS_BEFORE_HALT; i++) {
      recordTrip('agent-7', 'org-1', 'create_ticket_proposal', 409);
    }
    expect(isPersonaPaused('agent-7')).toBe(true);
    _resetForTesting();
    expect(isPersonaPaused('agent-7')).toBe(false);
  });
});
