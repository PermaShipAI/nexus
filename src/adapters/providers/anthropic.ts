import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import { usageReporter } from '../../telemetry/usage-reporter.js';
import type {
  LLMProvider,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  LLMToolCallResult,
  ModelTier,
} from '../interfaces/llm-provider.js';

const DEFAULT_MODEL_MAP: Record<ModelTier, string> = {
  ROUTER: 'claude-haiku-4-5-20251001',
  AGENT: 'claude-sonnet-4-6-20250116',
  WORK: 'claude-sonnet-4-6-20250116',
  EMBEDDING: '', // Anthropic has no embedding API
};

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private modelMap: Record<ModelTier, string>;

  constructor(apiKey: string, modelOverrides?: Partial<Record<ModelTier, string>>) {
    this.client = new Anthropic({ apiKey });
    this.modelMap = { ...DEFAULT_MODEL_MAP, ...modelOverrides };
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const model = this.modelMap[options.model];
    if (!model) throw new Error(`No Anthropic model configured for tier ${options.model}`);

    const messages = options.contents.map(c => ({
      role: (c.role === 'model' ? 'assistant' : c.role) as 'user' | 'assistant',
      content: c.parts.map(p => p.text ?? '').join(''),
    }));

    logger.debug({ model, tier: options.model }, 'Calling Anthropic');

    const response = await this.client.messages.create({
      model,
      max_tokens: 8192,
      system: options.systemInstruction || undefined,
      messages,
    });

    if (options.orgId && response.usage) {
      usageReporter.record(options.orgId, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });
    }

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('');

    logger.debug({ model, responseLength: text.length }, 'Anthropic response received');
    return text;
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    const model = this.modelMap[options.model];
    if (!model) throw new Error(`No Anthropic model configured for tier ${options.model}`);

    const messages = options.contents.map(c => ({
      role: (c.role === 'model' ? 'assistant' : c.role) as 'user' | 'assistant',
      content: c.parts.map(p => p.text ?? '').join(''),
    }));

    const tools = options.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: (t.parameters ?? { type: 'object' as const, properties: {} }) as Anthropic.Tool.InputSchema,
    }));

    const response = await this.client.messages.create({
      model,
      max_tokens: 8192,
      system: options.systemInstruction || undefined,
      messages,
      tools,
    });

    if (options.orgId && response.usage) {
      usageReporter.record(options.orgId, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });
    }

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('') || null;

    const functionCalls = response.content
      .filter(block => block.type === 'tool_use')
      .map(block => {
        if (block.type !== 'tool_use') throw new Error('unreachable');
        return {
          name: block.name,
          args: (block.input ?? {}) as Record<string, unknown>,
        };
      });

    return { text, functionCalls, raw: response };
  }

  async embedText(_text: string): Promise<number[] | null> {
    // Anthropic does not offer an embedding API.
    // Return null — knowledge service falls back to ILIKE text matching.
    return null;
  }
}
