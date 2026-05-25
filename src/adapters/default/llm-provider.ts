import { GoogleGenerativeAI, type Content, type FunctionDeclaration } from '@google/generative-ai';
import { getModelId } from '../../settings/service.js';
import { withRetry } from '../providers/retry.js';
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
    const override = options.orgId ? await getModelId(options.model, options.orgId) : null;
    const modelId = override || DEFAULT_MODEL_MAP[options.model];
    
    const model = this.genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: options.systemInstruction,
    });
    const result = await withRetry(
      () => model.generateContent({ contents: options.contents as Content[] }),
      undefined,
      `gemini.generateText[${modelId}]`,
    );
    const response = await result.response;
    return response.text();
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    const override = options.orgId ? await getModelId(options.model, options.orgId) : null;
    const modelId = override || DEFAULT_MODEL_MAP[options.model];

    const model = this.genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: options.systemInstruction,
      tools: [{ functionDeclarations: options.tools as FunctionDeclaration[] }],
    });
    const result = await withRetry(
      () => model.generateContent({ contents: options.contents as Content[] }),
      undefined,
      `gemini.generateWithTools[${modelId}]`,
    );
    const response = await result.response;

    // Surface safety blocks rather than silently returning empty results.
    // Prompt-level block (entire request rejected before generating candidates).
    if (response.promptFeedback?.blockReason) {
      throw new Error(`Gemini prompt blocked by safety filters: ${response.promptFeedback.blockReason}`);
    }
    const candidate = response.candidates?.[0];
    // Candidate-level block (generation started but was cut off by safety filters).
    if (candidate?.finishReason === 'SAFETY') {
      throw new Error('Gemini response blocked by safety filters');
    }

    const parts = candidate?.content?.parts ?? [];
    const functionCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        name: p.functionCall!.name!,
        args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
      }));

    const text = parts
      .filter((p) => p.text)
      .map((p) => p.text as string)
      .join('');

    return { text: text || null, functionCalls, raw: response };
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

