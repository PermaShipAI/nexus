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
  pendingActions: {},
  tickets: {},
  localProjects: {},
  botSettings: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  notInArray: vi.fn(),
  isNull: vi.fn(),
  count: vi.fn(),
  sql: vi.fn(),
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
  resolveOperatingWindow: vi.fn(),
}));

vi.mock('./backpressure.js', () => ({
  computeBackpressure: vi.fn(),
}));

vi.mock('./throttle.js', () => ({
  computeProjectThrottleLevel: vi.fn(),
}));

import { getAllProjectPolicies, resolveOperatingWindow } from './policy-resolver.js';
import { computeBackpressure } from './backpressure.js';
import { computeProjectThrottleLevel } from './throttle.js';
import { getSetting } from '../settings/service.js';
import { allocateNextProject } from './allocator.js';

const mockGetAllPolicies = vi.mocked(getAllProjectPolicies);
const mockResolveWindow = vi.mocked(resolveOperatingWindow);
const mockBackpressure = vi.mocked(computeBackpressure);
const mockProjectThrottle = vi.mocked(computeProjectThrottleLevel);
const mockGetSetting = vi.mocked(getSetting);

describe('allocateNextProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no operating window restrictions, no backpressure, normal throttle, no shadow mode
    mockResolveWindow.mockResolvedValue(null);
    mockBackpressure.mockResolvedValue(0);
    mockProjectThrottle.mockResolvedValue({ level: 'normal', pendingCount: 0, reason: 'ok' });
    mockGetSetting.mockResolvedValue(null);
  });

  it('returns null when no projects exist', async () => {
    mockGetAllPolicies.mockResolvedValue([]);
    const result = await allocateNextProject('org-1');
    expect(result).toBeNull();
  });

  it('returns null when all projects are focus=off', async () => {
    mockGetAllPolicies.mockResolvedValue([
      { id: 'p1', name: 'A', slug: 'a', policy: { focusLevel: 'off' } },
    ]);

    const result = await allocateNextProject('org-1');
    expect(result).toBeNull();
  });

  it('returns a project when eligible projects exist', async () => {
    mockGetAllPolicies.mockResolvedValue([
      { id: 'p1', name: 'Project A', slug: 'a', policy: { focusLevel: 'normal' } },
    ]);

    const result = await allocateNextProject('org-1');
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe('p1');
    expect(result!.projectName).toBe('Project A');
  });

  it('skips projects with paused throttle', async () => {
    mockGetAllPolicies.mockResolvedValue([
      { id: 'p1', name: 'A', slug: 'a', policy: { focusLevel: 'normal' } },
    ]);
    mockProjectThrottle.mockResolvedValue({ level: 'paused', pendingCount: 25, reason: 'paused' });

    const result = await allocateNextProject('org-1');
    expect(result).toBeNull();
  });

  it('skips projects with high backpressure (>=0.9)', async () => {
    mockGetAllPolicies.mockResolvedValue([
      { id: 'p1', name: 'A', slug: 'a', policy: { focusLevel: 'normal' } },
    ]);
    mockBackpressure.mockResolvedValue(0.95);

    const result = await allocateNextProject('org-1');
    expect(result).toBeNull();
  });

  it('returns null in shadow mode (logs but does not allocate)', async () => {
    mockGetSetting.mockResolvedValue(true); // nexus_improvements_shadow = true

    mockGetAllPolicies.mockResolvedValue([
      { id: 'p1', name: 'A', slug: 'a', policy: { focusLevel: 'normal' } },
    ]);

    const result = await allocateNextProject('org-1');
    expect(result).toBeNull();
  });

  it('selects from multiple eligible projects (does not crash)', async () => {
    mockGetAllPolicies.mockResolvedValue([
      { id: 'p1', name: 'Low', slug: 'low', policy: { focusLevel: 'low' } },   // 1/day
      { id: 'p2', name: 'High', slug: 'high', policy: { focusLevel: 'high' } }, // 8/day
    ]);

    const result = await allocateNextProject('org-1');
    expect(result).not.toBeNull();
    expect(['p1', 'p2']).toContain(result!.projectId);
  });
});
