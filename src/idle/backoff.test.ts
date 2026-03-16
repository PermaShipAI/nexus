import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../settings/service.js', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

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

import { getSetting, setSetting } from '../settings/service.js';
import { db } from '../db/index.js';
import {
  getBackoffStep,
  incrementBackoffStep,
  resetBackoffStep,
  getIdleInvocations24h,
} from './backoff.js';

const mockGetSetting = vi.mocked(getSetting);
const mockSetSetting = vi.mocked(setSetting);
const mockDb = vi.mocked(db);

describe('getBackoffStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(a) returns 0 when no setting stored (getSetting returns null)', async () => {
    mockGetSetting.mockResolvedValue(null);
    const result = await getBackoffStep('org-1');
    expect(result).toBe(0);
  });

  it('(b) returns the stored value when getSetting returns a valid step (e.g. 2)', async () => {
    mockGetSetting.mockResolvedValue(2);
    const result = await getBackoffStep('org-1');
    expect(result).toBe(2);
  });

  it('(c) clamps to MAX_STEP (3) if stored value exceeds 3 (e.g. getSetting returns 10)', async () => {
    mockGetSetting.mockResolvedValue(10);
    const result = await getBackoffStep('org-1');
    expect(result).toBe(3);
  });

  it('(d) returns 0 on getSetting exception (fail-open)', async () => {
    mockGetSetting.mockRejectedValue(new Error('DB connection error'));
    const result = await getBackoffStep('org-1');
    expect(result).toBe(0);
  });
});

describe('incrementBackoffStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(e) goes 0->1: when current step is 0, setSetting is called with 1', async () => {
    mockGetSetting.mockResolvedValue(0);
    mockSetSetting.mockResolvedValue(undefined);

    await incrementBackoffStep('org-1');

    expect(mockSetSetting).toHaveBeenCalledWith('idle_backoff_step', 1, 'org-1', 'system');
  });

  it('(f) stays at 3: when current step is 3, setSetting is called with 3 (not 4)', async () => {
    mockGetSetting.mockResolvedValue(3);
    mockSetSetting.mockResolvedValue(undefined);

    await incrementBackoffStep('org-1');

    expect(mockSetSetting).toHaveBeenCalledWith('idle_backoff_step', 3, 'org-1', 'system');
  });

  it('(g) on setSetting exception, catches and does not throw', async () => {
    mockGetSetting.mockResolvedValue(1);
    mockSetSetting.mockRejectedValue(new Error('Write failed'));

    await expect(incrementBackoffStep('org-1')).resolves.toBeUndefined();
  });
});

describe('resetBackoffStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(h) calls setSetting with 0 to reset the backoff step', async () => {
    mockSetSetting.mockResolvedValue(undefined);

    await resetBackoffStep('org-1');

    expect(mockSetSetting).toHaveBeenCalledWith('idle_backoff_step', 0, 'org-1', 'system');
  });
});

describe('getIdleInvocations24h', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(i) returns 0 when no idle entries in last 24h (DB returns value 0)', async () => {
    const mockWhere = vi.fn().mockResolvedValue([{ value: 0 }]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select = vi.fn().mockReturnValue({ from: mockFrom });

    const result = await getIdleInvocations24h('org-1');
    expect(result).toBe(0);
  });

  it('(j) returns the count from the DB query', async () => {
    const mockWhere = vi.fn().mockResolvedValue([{ value: 3 }]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select = vi.fn().mockReturnValue({ from: mockFrom });

    const result = await getIdleInvocations24h('org-1');
    expect(result).toBe(3);
  });

  it('(k) returns 0 on DB exception (fail-open)', async () => {
    const mockWhere = vi.fn().mockRejectedValue(new Error('Query failed'));
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select = vi.fn().mockReturnValue({ from: mockFrom });

    const result = await getIdleInvocations24h('org-1');
    expect(result).toBe(0);
  });
});
