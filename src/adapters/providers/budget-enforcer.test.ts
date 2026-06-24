import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../telemetry/token-budget.js', () => ({
  enforceTokenBudget: vi.fn().mockResolvedValue(undefined),
  TokenBudgetExceededError: class TokenBudgetExceededError extends Error {
    name = 'TokenBudgetExceededError';
  },
}));

import { TokenBudgetProvider } from './budget-enforcer.js';
import { enforceTokenBudget, TokenBudgetExceededError } from '../../telemetry/token-budget.js';

const mockEnforce = vi.mocked(enforceTokenBudget);

const mockInner = {
  generateText: vi.fn().mockResolvedValue('response text'),
  generateWithTools: vi.fn().mockResolvedValue({ text: 'tools response', functionCalls: [], raw: {} }),
  embedText: vi.fn().mockResolvedValue([0.1, 0.2]),
};

describe('TokenBudgetProvider', () => {
  let provider: TokenBudgetProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new TokenBudgetProvider(mockInner);
  });

  it('calls enforceTokenBudget before generateText', async () => {
    const options = { model: 'AGENT' as const, contents: [], orgId: 'org-1' };
    await provider.generateText(options);
    expect(mockEnforce).toHaveBeenCalledWith('org-1');
    expect(mockInner.generateText).toHaveBeenCalledWith(options);
  });

  it('calls enforceTokenBudget before generateWithTools', async () => {
    const options = { model: 'AGENT' as const, contents: [], tools: [], orgId: 'org-1' };
    await provider.generateWithTools(options);
    expect(mockEnforce).toHaveBeenCalledWith('org-1');
    expect(mockInner.generateWithTools).toHaveBeenCalledWith(options);
  });

  it('does not call inner when budget is exceeded', async () => {
    mockEnforce.mockRejectedValueOnce(new TokenBudgetExceededError());
    const options = { model: 'AGENT' as const, contents: [], orgId: 'org-1' };
    await expect(provider.generateText(options)).rejects.toThrow();
    expect(mockInner.generateText).not.toHaveBeenCalled();
  });

  it('delegates embedText without budget check', async () => {
    await provider.embedText('hello');
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(mockInner.embedText).toHaveBeenCalledWith('hello');
  });
});
