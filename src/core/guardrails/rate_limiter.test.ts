import { describe, it, expect, vi, afterEach } from 'vitest';
import { SettingsMutationRateLimiter, COOLDOWN_MS } from './rate_limiter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsMutationRateLimiter', () => {
  it('allows the first check with no prior record', () => {
    const limiter = new SettingsMutationRateLimiter();
    expect(limiter.check('autonomous_mode')).toEqual({ allowed: true });
  });

  it('blocks immediately after record()', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const limiter = new SettingsMutationRateLimiter();
    limiter.record('autonomous_mode');
    const result = limiter.check('autonomous_mode');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBe(COOLDOWN_MS);
    }
  });

  it('returns correct retryAfterMs when partially elapsed', () => {
    const limiter = new SettingsMutationRateLimiter();
    const recordTime = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(recordTime);
    limiter.record('autonomous_mode');

    const checkTime = recordTime + 30_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(checkTime);
    const result = limiter.check('autonomous_mode');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBe(30_000);
    }
  });

  it('allows again after cooldown expires', () => {
    const limiter = new SettingsMutationRateLimiter();
    const recordTime = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(recordTime);
    limiter.record('autonomous_mode');

    const checkTime = recordTime + COOLDOWN_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValueOnce(checkTime);
    expect(limiter.check('autonomous_mode')).toEqual({ allowed: true });
  });

  it('tracks different keys independently', () => {
    const limiter = new SettingsMutationRateLimiter();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    limiter.record('autonomous_mode');

    expect(limiter.check('public_channels')).toEqual({ allowed: true });
  });
});
