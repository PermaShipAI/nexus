import { describe, it, expect } from 'vitest';
import { isStateLockError } from './executor.js';

describe('isStateLockError', () => {
  it('returns true for 409 with waiting_for_human message', () => {
    expect(isStateLockError({ status: 409, message: 'invalid state transition: waiting_for_human' })).toBe(true);
  });

  it('returns true for 422 with invalid state transition message', () => {
    expect(isStateLockError({ status: 422, message: 'invalid state transition' })).toBe(true);
  });

  it('returns false for 409 with unrelated message', () => {
    expect(isStateLockError({ status: 409, message: 'bad request' })).toBe(false);
  });

  it('returns false for 400 with waiting_for_human message', () => {
    expect(isStateLockError({ status: 400, message: 'waiting_for_human' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isStateLockError(null)).toBe(false);
  });

  it('returns false for string error', () => {
    expect(isStateLockError('string error')).toBe(false);
  });

  it('returns true for state_lock message with 409', () => {
    expect(isStateLockError({ status: 409, message: 'state_lock active' })).toBe(true);
  });

  it('returns true using statusCode instead of status', () => {
    expect(isStateLockError({ statusCode: 422, message: 'waiting_for_human state' })).toBe(true);
  });
});
