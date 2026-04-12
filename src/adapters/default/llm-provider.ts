import { GoogleGenerativeAI, type Content, type FunctionDeclaration } from '@google/generative-ai';
import { getModelId } from '../../settings/service.js';
import { withRetry } from '../providers/retry.js';
import { geminiCircuitBreaker, GeminiCircuitOpenError } from '../providers/gemini-circuit-breaker.js';
import { geminiCbRejectedTotal } from '../../telemetry/prometheus.js';
import type {
  LLMProvider,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  LLMToolCallResult,
} from '../interfaces/llm-provider.js';

const DEFAULT_MODEL_MAP = {
  ROUTER: 'gemini-3-flash-preview',
  AGENT: 'gemini-3.1-pro-preview',
  WORK: 'gemini-3.1-pro-preview',
  EMBEDDING: 'text-embedding-001',
} as const;


export class DefaultLLMProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    if (geminiCircuitBreaker.isOpen()) {
      geminiCbRejectedTotal.inc();
      throw new GeminiCircuitOpenError();
    }
    const override = options.orgId ? await getModelId(options.model, options.orgId) : null;
    const modelId = override || DEFAULT_MODEL_MAP[options.model];

    const model = this.genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: options.systemInstruction,
    });
    try {
      const result = await withRetry(
        () => model.generateContent({ contents: options.contents as Content[] }),
        undefined,
        `gemini.generateText[${modelId}]`,
      );
      const response = await result.response;
      const text = response.text();
      geminiCircuitBreaker.recordSuccess();
      return text;
    } catch (err) {
      geminiCircuitBreaker.recordFailure(err);
      throw err;
    }
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    if (geminiCircuitBreaker.isOpen()) {
      geminiCbRejectedTotal.inc();
      throw new GeminiCircuitOpenError();
    }
    const override = options.orgId ? await getModelId(options.model, options.orgId) : null;
    const modelId = override || DEFAULT_MODEL_MAP[options.model];

    const model = this.genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: options.systemInstruction,
      tools: [{ functionDeclarations: options.tools as FunctionDeclaration[] }],
    });
    try {
      const result = await withRetry(
        () => model.generateContent({ contents: options.contents as Content[] }),
        undefined,
        `gemini.generateWithTools[${modelId}]`,
      );
      const response = await result.response;

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const functionCalls = parts
        .filter((p) => p.functionCall)
        .map((p) => ({
          name: p.functionCall!.name!,
          args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
        }));

      const text = parts
        .filter((p) => p.text)
        .map((p) => p.text)
        .join('');

      geminiCircuitBreaker.recordSuccess();
      return { text: text || null, functionCalls, raw: response };
    } catch (err) {
      geminiCircuitBreaker.recordFailure(err);
      throw err;
    }
  }

  async embedText(text: string): Promise<number[] | null> {
    try {
      const model = this.genAI.getGenerativeModel({ model: DEFAULT_MODEL_MAP.EMBEDDING });
      const result = await model.embedContent(text);
      return result.embedding.values;
    } catch {
      return null;
    }
  }
}

