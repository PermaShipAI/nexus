import type {
  LLMProvider,
  LLMToolCallResult,
} from '../adapters/interfaces/llm-provider.js';

const NOT_CONFIGURED_MSG = 'LLM provider is not configured. Please complete setup at http://localhost:3000 to set your API key.';

/**
 * Placeholder LLM provider used when no API key is configured.
 * All methods return a helpful error directing the user to the setup screen.
 */
export class PlaceholderLLMProvider implements LLMProvider {
  async generateText(): Promise<string> {
    return NOT_CONFIGURED_MSG;
  }

  async generateWithTools(): Promise<LLMToolCallResult> {
    return { text: NOT_CONFIGURED_MSG, functionCalls: [], raw: null };
  }

  async embedText(): Promise<number[] | null> {
    return null;
  }
}
