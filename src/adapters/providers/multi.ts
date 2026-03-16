import type {
  LLMProvider,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  LLMToolCallResult,
  ModelTier,
} from '../interfaces/llm-provider.js';

/**
 * Composite provider that routes different model tiers to different providers.
 * Example: use Anthropic for AGENT/WORK, Gemini for ROUTER (cheap), OpenAI for embeddings.
 */
export class MultiProvider implements LLMProvider {
  constructor(
    private providers: Partial<Record<ModelTier, LLMProvider>>,
    private fallback: LLMProvider,
    private embeddingProvider?: LLMProvider,
  ) {}

  private resolve(tier: ModelTier): LLMProvider {
    return this.providers[tier] ?? this.fallback;
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    return this.resolve(options.model).generateText(options);
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    return this.resolve(options.model).generateWithTools(options);
  }

  async embedText(text: string): Promise<number[] | null> {
    const provider = this.embeddingProvider ?? this.fallback;
    return provider.embedText(text);
  }
}
