/** Neutral content type — structurally compatible with @google/genai Content */
export interface LLMContent {
  role: string;
  parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> }; [key: string]: unknown }>;
}

/** Neutral function declaration — structurally compatible with @google/genai FunctionDeclaration */
export interface LLMFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ModelTier = 'ROUTER' | 'AGENT' | 'WORK' | 'EMBEDDING';

export interface GenerateTextOptions {
  model: ModelTier;
  systemInstruction?: string;
  contents: LLMContent[];
  orgId?: string;
}

export interface GenerateWithToolsOptions extends GenerateTextOptions {
  tools: LLMFunctionDeclaration[];
}

export interface LLMToolCallResult {
  text: string | null;
  functionCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
  raw: unknown;
}

export interface LLMProvider {
  generateText(options: GenerateTextOptions): Promise<string>;
  generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult>;
  embedText(text: string): Promise<number[] | null>;
}
