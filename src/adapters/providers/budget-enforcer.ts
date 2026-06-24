import type {
  LLMProvider,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  LLMToolCallResult,
} from '../interfaces/llm-provider.js';
import { enforceTokenBudget } from '../../telemetry/token-budget.js';

/**
 * Pre-flight token-budget enforcement middleware for LLM providers.
 *
 * Wraps any LLMProvider with a decorator that checks the org's token budget
 * before each generate call. Throws TokenBudgetExceededError when the org
 * has consumed all of its allocated tokens, preventing further spend.
 */
export class TokenBudgetProvider implements LLMProvider {
  constructor(private readonly inner: LLMProvider) {}

  async generateText(options: GenerateTextOptions): Promise<string> {
    await enforceTokenBudget(options.orgId);
    return this.inner.generateText(options);
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    await enforceTokenBudget(options.orgId);
    return this.inner.generateWithTools(options);
  }

  async embedText(text: string): Promise<number[] | null> {
    return this.inner.embedText(text);
  }
}
