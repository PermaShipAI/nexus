import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../settings/service.js', () => ({
  getSetting: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../usage-reporter.js', () => ({
  usageReporter: {
    getTotalTokens: vi.fn().mockReturnValue(0),
  },
}));

import { getSetting } from '../../settings/service.js';
import { usageReporter } from '../usage-reporter.js';
import {
  getTokenBudget,
  enforceTokenBudget,
  TokenBudgetExceededError,
} from '../token-budget.js';

const mockGetSetting = vi.mocked(getSetting);
const mockGetTotalTokens = vi.mocked(usageReporter.getTotalTokens);

describe('getTokenBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns numeric budget from settings', async () => {
    mockGetSetting.mockResolvedValue(50000);
    const budget = await getTokenBudget('org-1');
    expect(budget).toBe(50000);
    expect(mockGetSetting).toHaveBeenCalledWith('token_budget', 'org-1');
  });

  it('parses string budget from settings', async () => {
    mockGetSetting.mockResolvedValue('100000');
    const budget = await getTokenBudget('org-1');
    expect(budget).toBe(100000);
  });

  it('returns null when no budget is set', async () => {
    mockGetSetting.mockResolvedValue(null);
    const budget = await getTokenBudget('org-1');
    expect(budget).toBeNull();
  });

  it('returns null when budget is zero', async () => {
    mockGetSetting.mockResolvedValue(0);
    expect(await getTokenBudget('org-1')).toBeNull();
  });

  it('returns null when budget is negative', async () => {
    mockGetSetting.mockResolvedValue(-100);
    expect(await getTokenBudget('org-1')).toBeNull();
  });

  it('returns null and warns when settings read throws', async () => {
    mockGetSetting.mockRejectedValue(new Error('db error'));
    const budget = await getTokenBudget('org-1');
    expect(budget).toBeNull();
  });
});

describe('enforceTokenBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when orgId is undefined', async () => {
    await expect(enforceTokenBudget(undefined)).resolves.toBeUndefined();
    expect(mockGetSetting).not.toHaveBeenCalled();
  });

  it('does nothing when no budget is configured', async () => {
    mockGetSetting.mockResolvedValue(null);
    mockGetTotalTokens.mockReturnValue(999999);
    await expect(enforceTokenBudget('org-1')).resolves.toBeUndefined();
  });

  it('does nothing when usage is below budget', async () => {
    mockGetSetting.mockResolvedValue(10000);
    mockGetTotalTokens.mockReturnValue(5000);
    await expect(enforceTokenBudget('org-1')).resolves.toBeUndefined();
  });

  it('throws TokenBudgetExceededError when usage equals budget', async () => {
    mockGetSetting.mockResolvedValue(10000);
    mockGetTotalTokens.mockReturnValue(10000);
    await expect(enforceTokenBudget('org-1')).rejects.toThrow(TokenBudgetExceededError);
  });

  it('throws TokenBudgetExceededError when usage exceeds budget', async () => {
    mockGetSetting.mockResolvedValue(10000);
    mockGetTotalTokens.mockReturnValue(12000);
    const err = await enforceTokenBudget('org-1').catch(e => e);
    expect(err).toBeInstanceOf(TokenBudgetExceededError);
    expect(err.orgId).toBe('org-1');
    expect(err.tokensUsed).toBe(12000);
    expect(err.budget).toBe(10000);
    expect(err.message).toContain('Token budget exceeded');
  });
});
