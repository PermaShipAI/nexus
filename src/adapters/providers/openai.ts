import OpenAI from 'openai';
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
  ROUTER: 'gpt-4.1-mini',
  AGENT: 'gpt-4.1',
  WORK: 'o3',
  EMBEDDING: 'text-embedding-3-small',
};

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private modelMap: Record<ModelTier, string>;

  constructor(apiKey: string, modelOverrides?: Partial<Record<ModelTier, string>>, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.modelMap = { ...DEFAULT_MODEL_MAP, ...modelOverrides };
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const model = this.modelMap[options.model];
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (options.systemInstruction) {
      messages.push({ role: 'system', content: options.systemInstruction });
    }
    for (const c of options.contents) {
      messages.push({
        role: c.role === 'model' ? 'assistant' : c.role as 'user' | 'assistant',
        content: c.parts.map(p => p.text ?? '').join(''),
      });
    }

    logger.debug({ model, tier: options.model }, 'Calling OpenAI');

    const response = await withRetry(
      () => this.client.chat.completions.create({ model, messages }),
      undefined,
      `openai.generateText[${model}]`,
    );

    if (options.orgId && response.usage) {
      usageReporter.record(options.orgId, {
        inputTokens: response.usage.prompt_tokens ?? 0,
        outputTokens: response.usage.completion_tokens ?? 0,
      });
    }

    const text = response.choices[0]?.message?.content ?? '';
    logger.debug({ model, responseLength: text.length }, 'OpenAI response received');
    return text;
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    const model = this.modelMap[options.model];
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (options.systemInstruction) {
      messages.push({ role: 'system', content: options.systemInstruction });
    }
    for (const c of options.contents) {
      const hasFunctionCall = c.parts.some(p => p.functionCall);
      const hasFunctionResponse = c.parts.some(p => p.functionResponse);

      if (hasFunctionCall) {
        // Assistant message with tool_calls
        const textContent = c.parts.filter(p => p.text).map(p => p.text).join('') || null;
        const toolCalls = c.parts
          .filter(p => p.functionCall)
          .map(p => ({
            id: p.functionCall!.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function' as const,
            function: {
              name: p.functionCall!.name,
              arguments: JSON.stringify(p.functionCall!.args),
            },
          }));
        messages.push({ role: 'assistant', content: textContent, tool_calls: toolCalls });
      } else if (hasFunctionResponse) {
        // Tool result messages
        for (const p of c.parts) {
          if (p.functionResponse) {
            messages.push({
              role: 'tool',
              tool_call_id: p.functionResponse.id ?? 'unknown',
              content: typeof p.functionResponse.response === 'string'
                ? p.functionResponse.response
                : JSON.stringify(p.functionResponse.response),
            });
          }
        }
      } else {
        messages.push({
          role: c.role === 'model' ? 'assistant' : c.role as 'user' | 'assistant',
          content: c.parts.map(p => p.text ?? '').join(''),
        });
      }
    }

    const tools: OpenAI.ChatCompletionTool[] = options.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }));

    const response = await withRetry(
      () => this.client.chat.completions.create({ model, messages, tools }),
      undefined,
      `openai.generateWithTools[${model}]`,
    );

    if (options.orgId && response.usage) {
      usageReporter.record(options.orgId, {
        inputTokens: response.usage.prompt_tokens ?? 0,
        outputTokens: response.usage.completion_tokens ?? 0,
      });
    }

    const choice = response.choices[0]?.message;
    const text = choice?.content ?? null;
    const functionCalls = (choice?.tool_calls ?? [])
      .filter(tc => tc.type === 'function')
      .map(tc => {
        const fn = tc as Extract<typeof tc, { type: 'function' }>;
        return {
          name: fn.function.name,
          args: JSON.parse(fn.function.arguments || '{}') as Record<string, unknown>,
          id: fn.id,
        };
      });

    return { text, functionCalls, raw: response };
  }

  async embedText(text: string): Promise<number[] | null> {
    const model = this.modelMap.EMBEDDING;
    if (!model) return null;

    try {
      const response = await withRetry(
        () => this.client.embeddings.create({ model, input: text }),
        undefined,
        `openai.embedText[${model}]`,
      );
      return response.data[0]?.embedding ?? null;
    } catch (err) {
      logger.warn({ err }, 'OpenAI embedding failed');
      return null;
    }
  }
}
