/** Neutral content type — structurally compatible with @google/genai Content */
export interface LLMContent {
  role: string;
  parts: Array<{
    text?: string;
    functionCall?: { name: string; args: Record<string, unknown>; id?: string };
    functionResponse?: { name: string; response: unknown; id?: string };
    [key: string]: unknown;
  }>;
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
  /** When set to 0, disables sampling and forces the most likely token at each step,
   *  producing fully deterministic outputs. Useful for routing, QA verification, and
   *  any call where reproducibility matters more than creative variety. */
  temperature?: number;
}

export interface GenerateWithToolsOptions extends GenerateTextOptions {
  tools: LLMFunctionDeclaration[];
}

export interface LLMToolCallResult {
  text: string | null;
  functionCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    id?: string;
  }>;
  raw: unknown;
}

export interface LLMProvider {
  generateText(options: GenerateTextOptions): Promise<string>;
  generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult>;
  embedText(text: string): Promise<number[] | null>;
}
