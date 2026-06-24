import { getSetting } from '../settings/service.js';
import { usageReporter } from './usage-reporter.js';
import { logger } from '../logger.js';

export class TokenBudgetExceededError extends Error {
  constructor(
    public readonly orgId: string,
    public readonly tokensUsed: number,
    public readonly budget: number,
  ) {
    super(
      `Token budget exceeded for org ${orgId}: ${tokensUsed} tokens used, budget is ${budget}`,
    );
    this.name = 'TokenBudgetExceededError';
  }
}

/**
 * Read the configured token budget for an org.
 * Returns null if no budget is set (unlimited).
 * Setting key: "token_budget" — a positive integer representing the maximum
 * total tokens (input + output) the org may consume since the process started.
 */
export async function getTokenBudget(orgId: string): Promise<number | null> {
  try {
    const raw = await getSetting('token_budget', orgId);
    const budget =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? parseInt(raw, 10)
          : NaN;
    if (!isNaN(budget) && budget > 0) return budget;
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to read token_budget setting');
  }
  return null;
}

/**
 * Enforce the token budget for an org before making an LLM call.
 * Throws TokenBudgetExceededError when the org has consumed >= its configured budget.
 * No-ops when orgId is absent or no budget is configured.
 */
export async function enforceTokenBudget(orgId: string | undefined): Promise<void> {
  if (!orgId) return;

  const budget = await getTokenBudget(orgId);
  if (budget === null) return; // no budget configured — unlimited

  const used = usageReporter.getTotalTokens(orgId);
  if (used >= budget) {
    logger.warn({
      event: 'token_budget_exceeded',
      orgId,
      tokensUsed: used,
      budget,
    });
    throw new TokenBudgetExceededError(orgId, used, budget);
  }
}
