import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import { usageReporter } from '../../telemetry/usage-reporter.js';
import { withRetry } from './retry.js';
import type {
  LLMProvider,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  LLMToolCallResult,
  ModelTier,
} from '../interfaces/llm-provider.js';

const DEFAULT_MODEL_MAP: Record<ModelTier, string> = {
  ROUTER: 'claude-haiku-4-5-20251001',
  AGENT: 'claude-sonnet-4-6',
  WORK: 'claude-sonnet-4-6',
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

    const response = await withRetry(
      () => this.client.messages.create({
        model,
        max_tokens: 8192,
        system: options.systemInstruction || undefined,
        messages,
      }),
      undefined,
      `anthropic.generateText[${model}]`,
    );

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

    const messages: Anthropic.MessageParam[] = [];
    for (const c of options.contents) {
      const role = (c.role === 'model' ? 'assistant' : c.role) as 'user' | 'assistant';

      // Check if this content has functionCall or functionResponse parts
      const hasFunctionCall = c.parts.some(p => p.functionCall);
      const hasFunctionResponse = c.parts.some(p => p.functionResponse);

      if (hasFunctionCall) {
        // Assistant message with tool_use blocks
        const content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = [];
        for (const p of c.parts) {
          if (p.text) content.push({ type: 'text', text: p.text });
          if (p.functionCall) {
            content.push({
              type: 'tool_use',
              id: p.functionCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
              name: p.functionCall.name,
              input: p.functionCall.args,
            });
          }
        }
        messages.push({ role: 'assistant', content: content as any });
      } else if (hasFunctionResponse) {
        // User message with tool_result blocks
        const content: Array<Anthropic.ToolResultBlockParam> = [];
        for (const p of c.parts) {
          if (p.functionResponse) {
            content.push({
              type: 'tool_result' as const,
              tool_use_id: p.functionResponse.id ?? 'unknown',
              content: typeof p.functionResponse.response === 'string'
                ? p.functionResponse.response
                : JSON.stringify(p.functionResponse.response),
            });
          }
        }
        messages.push({ role: 'user', content });
      } else {
        // Plain text message
        messages.push({
          role,
          content: c.parts.map(p => p.text ?? '').join(''),
        });
      }
    }

    const tools = options.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: (t.parameters ?? { type: 'object' as const, properties: {} }) as Anthropic.Tool.InputSchema,
    }));

    const response = await withRetry(
      () => this.client.messages.create({
        model,
        max_tokens: 8192,
        system: options.systemInstruction || undefined,
        messages,
        tools,
      }),
      undefined,
      `anthropic.generateWithTools[${model}]`,
    );

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
          id: block.id,
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
