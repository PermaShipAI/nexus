import type { Content, FunctionDeclaration } from '@google/generative-ai';
import { callGemini, callGeminiWithTools, embedText } from '../../gemini/client.js';
import type {
  LLMProvider,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  LLMToolCallResult,
} from '../interfaces/llm-provider.js';

export class GeminiLLMProvider implements LLMProvider {
  async generateText(options: GenerateTextOptions): Promise<string> {
    return callGemini({
      model: options.model,
      systemInstruction: options.systemInstruction,
      contents: options.contents as Content[],
      orgId: options.orgId,
    });
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    return callGeminiWithTools({
      model: options.model,
      systemInstruction: options.systemInstruction,
      contents: options.contents as Content[],
      orgId: options.orgId,
      tools: options.tools as FunctionDeclaration[],
    });
  }

  async embedText(text: string): Promise<number[] | null> {
    return embedText(text);
  }
}
