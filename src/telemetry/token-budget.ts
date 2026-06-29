import { logger } from '../logger.js';
import { getSetting } from '../settings/service.js';
import { usageReporter } from './usage-reporter.js';

export class TokenBudgetExceededError extends Error {
  constructor(
    public readonly orgId: string,
    public readonly tokensUsed: number,
    public readonly budget: number,
  ) {
    super(
      `Token budget exceeded for org ${orgId}: used ${tokensUsed} of ${budget} tokens`,
    );
    this.name = 'TokenBudgetExceededError';
  }
}

export async function getTokenBudget(orgId: string): Promise<number | null> {
  const value = await getSetting('token_budget', orgId);
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export async function enforceTokenBudget(orgId: string | undefined): Promise<void> {
  if (!orgId) return;

  const budget = await getTokenBudget(orgId);
  if (budget === null) return;

  const tokensUsed = usageReporter.getTotalTokens(orgId);
  if (tokensUsed >= budget) {
    logger.warn(
      { event: 'token_budget.exceeded', orgId, tokensUsed, budget },
      'Token budget exceeded — rejecting LLM call',
    );
    throw new TokenBudgetExceededError(orgId, tokensUsed, budget);
  }
}
