import { describe, it, expect } from 'vitest';
import {
  VALID_MISSION_ITEM_TRANSITIONS,
  StateTransitionError,
  assertValidMissionItemTransition,
} from './state-machine.js';

const ITEM_ID = 'item-abc-123';
const AGENT_ID = 'sre';

describe('VALID_MISSION_ITEM_TRANSITIONS', () => {
  it('covers all expected states', () => {
    const states = Object.keys(VALID_MISSION_ITEM_TRANSITIONS);
    expect(states).toContain('pending');
    expect(states).toContain('in_progress');
    expect(states).toContain('agent_complete');
    expect(states).toContain('verified');
    expect(states).toContain('waiting_for_human');
  });
});

describe('StateTransitionError', () => {
  it('is instanceof Error', () => {
    const err = new StateTransitionError(ITEM_ID, 'pending', 'verified');
    expect(err).toBeInstanceOf(Error);
  });

  it('is instanceof StateTransitionError', () => {
    const err = new StateTransitionError(ITEM_ID, 'pending', 'verified');
    expect(err).toBeInstanceOf(StateTransitionError);
  });

  it('sets name to StateTransitionError', () => {
    const err = new StateTransitionError(ITEM_ID, 'pending', 'verified');
    expect(err.name).toBe('StateTransitionError');
  });

  it('exposes itemId, fromStatus, toStatus as public properties', () => {
    const err = new StateTransitionError(ITEM_ID, 'in_progress', 'verified', AGENT_ID);
    expect(err.itemId).toBe(ITEM_ID);
    expect(err.fromStatus).toBe('in_progress');
    expect(err.toStatus).toBe('verified');
    expect(err.agentId).toBe(AGENT_ID);
  });

  it('agentId is undefined when not provided', () => {
    const err = new StateTransitionError(ITEM_ID, 'pending', 'in_progress');
    expect(err.agentId).toBeUndefined();
  });

  it('message contains itemId, fromStatus and toStatus', () => {
    const err = new StateTransitionError(ITEM_ID, 'verified', 'in_progress');
    expect(err.message).toContain(ITEM_ID);
    expect(err.message).toContain('verified');
    expect(err.message).toContain('in_progress');
  });
});

describe('assertValidMissionItemTransition — valid transitions', () => {
  it('pending → in_progress is valid', () => {
    expect(() => assertValidMissionItemTransition(ITEM_ID, 'pending', 'in_progress')).not.toThrow();
  });

  it('in_progress → agent_complete is valid', () => {
    expect(() => assertValidMissionItemTransition(ITEM_ID, 'in_progress', 'agent_complete')).not.toThrow();
  });

  it('in_progress → in_progress is valid (heartbeat self-transition)', () => {
    expect(() => assertValidMissionItemTransition(ITEM_ID, 'in_progress', 'in_progress')).not.toThrow();
  });

  it('agent_complete → verified is valid', () => {
    expect(() => assertValidMissionItemTransition(ITEM_ID, 'agent_complete', 'verified')).not.toThrow();
  });

  it('agent_complete → in_progress is valid (reopen)', () => {
    expect(() => assertValidMissionItemTransition(ITEM_ID, 'agent_complete', 'in_progress')).not.toThrow();
  });
});

describe('assertValidMissionItemTransition — invalid transitions', () => {
  const invalidCases: Array<[string, string]> = [
    ['pending', 'verified'],
    ['pending', 'agent_complete'],
    ['pending', 'waiting_for_human'],
    ['in_progress', 'verified'],
    ['in_progress', 'pending'],
    ['in_progress', 'waiting_for_human'],
    ['agent_complete', 'pending'],
    ['agent_complete', 'waiting_for_human'],
    ['verified', 'in_progress'],
    ['verified', 'agent_complete'],
    ['verified', 'pending'],
    ['verified', 'waiting_for_human'],
    ['waiting_for_human', 'in_progress'],
    ['waiting_for_human', 'verified'],
  ];

  for (const [from, to] of invalidCases) {
    it(`${from} → ${to} throws StateTransitionError`, () => {
      expect(() => assertValidMissionItemTransition(ITEM_ID, from, to, AGENT_ID)).toThrow(StateTransitionError);
    });

    it(`${from} → ${to} error has correct fields`, () => {
      try {
        assertValidMissionItemTransition(ITEM_ID, from, to, AGENT_ID);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StateTransitionError);
        const ste = err as StateTransitionError;
        expect(ste.itemId).toBe(ITEM_ID);
        expect(ste.fromStatus).toBe(from);
        expect(ste.toStatus).toBe(to);
        expect(ste.agentId).toBe(AGENT_ID);
      }
    });
  }

  it('unknown from-state throws StateTransitionError', () => {
    expect(() => assertValidMissionItemTransition(ITEM_ID, 'nonexistent', 'in_progress')).toThrow(StateTransitionError);
  });
});
