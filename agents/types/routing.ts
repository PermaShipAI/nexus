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
  actionableOptions?: string[];
  isCircuitBroken?: boolean;
  isStrictConsultation?: boolean;
  needsDeepResearch?: boolean;
}

export interface FeatureFlags {
  ENABLE_STRUCTURED_INTENT: boolean;
}
