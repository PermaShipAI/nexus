/** Gemini model tiers for different workloads */
export const MODELS = {
  /** Fast routing model — triage incoming messages to pick an agent */
  ROUTER: 'gemini-3-flash-preview',
  /** Conversational model — agent responses and analysis */
  AGENT: 'gemini-3.1-pro-preview',
  /** Deep work model — ticket composition, codebase analysis */
  WORK: 'gemini-3.1-pro-preview',
  /** Text embedding model — vector storage and RAG */
  EMBEDDING: 'gemini-embedding-001',
} as const;


/** Fallback model used when the primary model's quota is exhausted (429) */
export const FALLBACK_MODEL = 'gemini-3-flash-preview';

export type ModelTier = keyof typeof MODELS;
