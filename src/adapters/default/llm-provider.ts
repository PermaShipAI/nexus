import { GoogleGenerativeAI, type Content, type FunctionDeclaration } from '@google/generative-ai';
import { getModelId } from '../../settings/service.js';
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
    const result = await model.generateContent({
      contents: options.contents as Content[],
    });
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
    const result = await model.generateContent({
      contents: options.contents as Content[],
    });
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

