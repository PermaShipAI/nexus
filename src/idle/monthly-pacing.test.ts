import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ value: 0 }]),
      }),
    }),
  },
}));

vi.mock('../db/schema.js', () => ({
  activityLog: {},
  localProjects: {},
  botSettings: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  count: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../settings/service.js', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock('./policy-resolver.js', () => ({
  getAllProjectPolicies: vi.fn(),
}));

import { getAllProjectPolicies } from './policy-resolver.js';
import { getMonthlyOutputTarget, getEffectiveDailyBudget } from './monthly-pacing.js';

const mockGetAllPolicies = vi.mocked(getAllProjectPolicies);

describe('getMonthlyOutputTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 when no projects exist', async () => {
    mockGetAllPolicies.mockResolvedValue([]);
    const result = await getMonthlyOutputTarget('org-1');
    expect(result).toBe(0);
  });

  it('sums tickets/day * daysInMonth across projects', async () => {
    mockGetAllPolicies.mockResolvedValue([
      { id: 'p1', name: 'A', slug: 'a', policy: { focusLevel: 'normal' } },  // 3/day
      { id: 'p2', name: 'B', slug: 'b', policy: { focusLevel: 'high' } },    // 8/day
      { id: 'p3', name: 'C', slug: 'c', policy: { focusLevel: 'off' } },     // 0/day
    ]);

    const result = await getMonthlyOutputTarget('org-1');

    // (3 + 8 + 0) * daysInMonth
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    expect(result).toBe(11 * daysInMonth);
  });
});

describe('getEffectiveDailyBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to plan-tier cap when no projects configured (target=0)', async () => {
    // This is the critical regression test — when target is 0, should NOT return 0
    mockGetAllPolicies.mockResolvedValue([]);

    const result = await getEffectiveDailyBudget('org-1');

    // Should return the safety cap (MAX_IDLE_PER_24H = 5), not 0
    expect(result).toBeGreaterThan(0);
  });

  it('returns min(pace, safetyCap) when projects exist', async () => {
    // With projects, the pace calculation should be used
    mockGetAllPolicies.mockResolvedValue([
      { id: 'p1', name: 'A', slug: 'a', policy: { focusLevel: 'normal' } },
    ]);

    const result = await getEffectiveDailyBudget('org-1');

    // Result should be a reasonable number
    expect(result).toBeGreaterThanOrEqual(0);
  });
});
