import { logger } from '../../logger.js';
import { withRetry } from './retry.js';
import type {
  LLMProvider,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  LLMToolCallResult,
  ModelTier,
} from '../interfaces/llm-provider.js';

const DEFAULT_MODEL_MAP: Record<ModelTier, string> = {
  ROUTER: 'llama3.3',
  AGENT: 'qwen3:32b',
  WORK: 'qwen3:32b',
  EMBEDDING: 'nomic-embed-text',
};

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private modelMap: Record<ModelTier, string>;

  constructor(baseUrl = 'http://127.0.0.1:11434', modelOverrides?: Partial<Record<ModelTier, string>>) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.modelMap = { ...DEFAULT_MODEL_MAP, ...modelOverrides };
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const model = this.modelMap[options.model];
    const messages: Array<{ role: string; content: string }> = [];

    if (options.systemInstruction) {
      messages.push({ role: 'system', content: options.systemInstruction });
    }
    for (const c of options.contents) {
      messages.push({
        role: c.role === 'model' ? 'assistant' : c.role,
        content: c.parts.map(p => p.text ?? '').join(''),
      });
    }

    logger.debug({ model, tier: options.model }, 'Calling Ollama');

    const data = await withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama error ${response.status}: ${body}`);
      }
      return response.json() as Promise<{ message?: { content?: string } }>;
    }, undefined, `ollama.generateText[${model}]`);

    const text = data.message?.content ?? '';
    logger.debug({ model, responseLength: text.length }, 'Ollama response received');
    return text;
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    const model = this.modelMap[options.model];
    const messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];

    if (options.systemInstruction) {
      messages.push({ role: 'system', content: options.systemInstruction });
    }
    for (const c of options.contents) {
      const hasFunctionCall = c.parts.some(p => p.functionCall);
      const hasFunctionResponse = c.parts.some(p => p.functionResponse);

      if (hasFunctionCall) {
        const textContent = c.parts.filter(p => p.text).map(p => p.text).join('');
        const toolCalls = c.parts
          .filter(p => p.functionCall)
          .map(p => ({
            id: p.functionCall!.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: {
              name: p.functionCall!.name,
              arguments: p.functionCall!.args,
            },
          }));
        messages.push({ role: 'assistant', content: textContent, tool_calls: toolCalls });
      } else if (hasFunctionResponse) {
        for (const p of c.parts) {
          if (p.functionResponse) {
            messages.push({
              role: 'tool',
              content: typeof p.functionResponse.response === 'string'
                ? p.functionResponse.response
                : JSON.stringify(p.functionResponse.response),
              tool_call_id: p.functionResponse.id ?? 'unknown',
            });
          }
        }
      } else {
        messages.push({
          role: c.role === 'model' ? 'assistant' : c.role,
          content: c.parts.map(p => p.text ?? '').join(''),
        });
      }
    }

    const tools = options.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }));

    const data = await withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, stream: false }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama error ${response.status}: ${body}`);
      }
      return response.json();
    }, undefined, `ollama.generateWithTools[${model}]`) as {
      message?: {
        content?: string;
        tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
      };
    };

    const text = data.message?.content || null;
    const functionCalls = (data.message?.tool_calls ?? []).map(tc => ({
      name: tc.function.name,
      args: tc.function.arguments,
    }));

    return { text, functionCalls, raw: data };
  }

  async embedText(text: string): Promise<number[] | null> {
    const model = this.modelMap.EMBEDDING;
    if (!model) return null;

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      });

      if (!response.ok) return null;

      const data = await response.json() as { embeddings?: number[][] };
      return data.embeddings?.[0] ?? null;
    } catch (err) {
      logger.warn({ err }, 'Ollama embedding failed');
      return null;
    }
  }
}
