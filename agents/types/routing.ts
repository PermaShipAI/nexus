export interface RouteResult {
  agentId: string;
  intent: string;
  subMessage: string;
  confidenceScore: number;
  reasoning: string;
  extractedEntities: Record<string, unknown>;
  needsCodeAccess: boolean;
  isStrategySession: boolean;
  requiresConfirmation?: boolean;
  isFallback: boolean;
  fallbackMessage?: string;
  isCircuitBroken?: boolean;
  isStrictConsultation?: boolean;
}

export interface FeatureFlags {
  ENABLE_STRUCTURED_INTENT: boolean;
}
