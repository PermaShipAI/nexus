import { enforceTokenBudget } from '../../telemetry/token-budget.js';
import type {
  LLMProvider,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  LLMToolCallResult,
} from '../interfaces/llm-provider.js';

/**
 * Decorator that enforces a per-org token budget before every LLM call.
 * Throws TokenBudgetExceededError if the org has consumed >= its configured budget.
 * Embedding calls are excluded from budget enforcement.
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
