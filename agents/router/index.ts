import { readFileSync } from 'fs';
import { join } from 'path';
import { GoogleGenAI } from '@google/genai';
import { IntentResponseSchema, INTENT_RESPONSE_JSON_SCHEMA } from '../schemas/intent.js';
import type { RouteResult, FeatureFlags } from '../types/routing.js';
import { logRoutingDecision, logger, logSecurityEvent, logAdministrativeIntentClarificationEvent } from '../telemetry/logger.js';
import { buildIntentPrompt } from './prompts.js';
import { checkForInjection } from '../../src/core/guardrails/prompt_injection.js';
import { isIntentLocked, CIRCUIT_BREAKER_MESSAGE } from './circuit_breaker.js';

// Read feature flags at module load time, once
let featureFlags: FeatureFlags = { ENABLE_STRUCTURED_INTENT: false };

try {
  const flagsRaw = readFileSync(
    join(process.cwd(), 'config/feature_flags.json'),
    'utf-8',
  );
  featureFlags = JSON.parse(flagsRaw) as FeatureFlags;
} catch (err) {
  logger.warn(
    { err },
    'Failed to read config/feature_flags.json; defaulting ENABLE_STRUCTURED_INTENT to false',
  );
}

const AGENT_IDS = [
  'ciso',
  'qa-manager',
  'sre',
  'ux-designer',
  'agentops',
  'finops',
  'product-manager',
  'release-engineering',
  'voc',
  'nexus',
];

const PARSE_ERROR_FALLBACK = (content: string): RouteResult => ({
  agentId: 'none',
  intent: 'GeneralInquiry',
  subMessage: content,
  confidenceScore: 0,
  reasoning: 'Failed to parse structured response',
  extractedEntities: {},
  needsCodeAccess: false,
  isStrategySession: false,
  requiresConfirmation: false,
  isFallback: true,
  fallbackMessage: 'I had trouble understanding your request. Could you rephrase it?',
});

const INJECTION_REFUSAL: RouteResult = {
  agentId: 'none',
  intent: 'GeneralInquiry',
  subMessage: '',
  confidenceScore: 0,
  reasoning: 'Prompt injection detected',
  extractedEntities: {},
  needsCodeAccess: false,
  isStrategySession: false,
  isFallback: true,
  fallbackMessage: "I'm unable to process that request.",
};

export async function routeMessage(
  content: string,
  channelId: string,
  userName: string,
  sessionId?: string,
): Promise<RouteResult[]> {
  const injectionCheck = checkForInjection(content);
  if (injectionCheck.detected) {
    logSecurityEvent('prompt_injection_detected', {
      matchedPattern: injectionCheck.matchedPattern,
      channelId,
      userName,
    });
    return [{ ...INJECTION_REFUSAL, subMessage: content }];
  }

  const resolvedSession = sessionId ?? channelId;
  if (featureFlags.ENABLE_STRUCTURED_INTENT) {
    const startTime = Date.now();

    try {
      const prompt = buildIntentPrompt(content, AGENT_IDS);
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: INTENT_RESPONSE_JSON_SCHEMA,
        },
      });

      const text = response.text;
      const elapsedMs = Date.now() - startTime;

      let parsed: any;
      try {
        parsed = JSON.parse(text ?? '');
      } catch {
        logger.warn({ channelId, userName }, 'Failed to JSON.parse Gemini response');
        logRoutingDecision(PARSE_ERROR_FALLBACK(content), elapsedMs);
        return [PARSE_ERROR_FALLBACK(content)];
      }

      const validation = IntentResponseSchema.safeParse(parsed);
      if (!validation.success) {
        logger.warn(
          { channelId, userName, issues: validation.error.issues },
          'Gemini response failed Zod validation',
        );
        logRoutingDecision(PARSE_ERROR_FALLBACK(content), elapsedMs);
        return [PARSE_ERROR_FALLBACK(content)];
      }

      const intentData = validation.data;

      if (intentData.confidenceScore < 0.6) {
        const lowConfidenceResult: RouteResult = {
          agentId: 'none',
          intent: intentData.intent,
          subMessage: content,
          confidenceScore: intentData.confidenceScore,
          reasoning: intentData.reasoning,
          extractedEntities: {},
          needsCodeAccess: false,
          isStrategySession: false,
          requiresConfirmation: false,
          isFallback: true,
          fallbackMessage:
            "I'm not fully confident I understood your request. Could you provide more details?",
        };
        if (intentData.intent === 'AdministrativeAction') {
          logAdministrativeIntentClarificationEvent({ confidenceScore: intentData.confidenceScore, channelId, userName });
        }
        logRoutingDecision(lowConfidenceResult, elapsedMs);
        return [lowConfidenceResult];
      }

      if (isIntentLocked(resolvedSession, intentData.intent)) {
        const circuitBrokenResult: RouteResult = {
          agentId: 'none',
          intent: intentData.intent,
          subMessage: content,
          confidenceScore: intentData.confidenceScore,
          reasoning: 'Circuit breaker: intent previously refused for this session',
          extractedEntities: {},
          needsCodeAccess: false,
          isStrategySession: false,
          isFallback: true,
          isCircuitBroken: true,
          fallbackMessage: CIRCUIT_BREAKER_MESSAGE,
        };
        logger.warn({
          event: 'circuit_breaker.fired',
          sessionId: resolvedSession,
          intent: intentData.intent,
          elapsedMs,
        });
        logRoutingDecision(circuitBrokenResult, elapsedMs);
        return [circuitBrokenResult];
      }

      const isStrictConsultation = intentData.intent === 'StrictConsultation';
      const result: RouteResult = {
        agentId: intentData.targetAgent,
        intent: intentData.intent,
        subMessage: content,
        confidenceScore: intentData.confidenceScore,
        reasoning: intentData.reasoning,
        extractedEntities: intentData.extractedEntities,
        needsCodeAccess: isStrictConsultation ? false : intentData.needsCodeAccess,
        isStrategySession: intentData.isStrategySession,
        requiresConfirmation: intentData.requiresConfirmation,
        isFallback: false,
        isStrictConsultation,
      };

      logRoutingDecision(result, elapsedMs);
      return [result];
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      logger.error(
        { err, channelId, userName },
        'Unexpected error during structured intent routing',
      );
      logRoutingDecision(PARSE_ERROR_FALLBACK(content), elapsedMs);
      return [PARSE_ERROR_FALLBACK(content)];
    }
  } else {
    // Legacy unstructured routing path
    const legacyResult: RouteResult = {
      agentId: 'nexus',
      intent: 'unstructured',
      subMessage: content,
      confidenceScore: -1,
      reasoning: 'Legacy routing: structured intent recognition is disabled',
      extractedEntities: {},
      needsCodeAccess: false,
      isStrategySession: false,
      isFallback: false,
    };

    logRoutingDecision(legacyResult, 0);
    return [legacyResult];
  }
}
