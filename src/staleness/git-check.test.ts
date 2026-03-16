import '../tests/env.js';
import { describe, it, expect } from 'vitest';
import { getAdaptiveTtlDays } from './git-check.js';

describe('getAdaptiveTtlDays', () => {
  it('returns 2 days for high-activity repos (>10 commits/day)', () => {
    expect(getAdaptiveTtlDays(15)).toBe(2);
    expect(getAdaptiveTtlDays(11)).toBe(2);
    expect(getAdaptiveTtlDays(100)).toBe(2);
  });

  it('returns 5 days for medium-activity repos (3-10 commits/day)', () => {
    expect(getAdaptiveTtlDays(3)).toBe(5);
    expect(getAdaptiveTtlDays(5)).toBe(5);
    expect(getAdaptiveTtlDays(10)).toBe(5);
  });

  it('returns 10 days for low-activity repos (<3 commits/day)', () => {
    expect(getAdaptiveTtlDays(1)).toBe(10);
    expect(getAdaptiveTtlDays(2.9)).toBe(10);
    expect(getAdaptiveTtlDays(0.1)).toBe(10);
  });

  it('returns default TTL for zero commit frequency', () => {
    expect(getAdaptiveTtlDays(0)).toBe(7); // STALENESS_DEFAULT_TTL_DAYS default
  });

  it('returns default TTL when commit frequency is null', () => {
    expect(getAdaptiveTtlDays(null)).toBe(7);
  });
});
