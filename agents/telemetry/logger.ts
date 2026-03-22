import pino from 'pino';
import type { RouteResult } from '../types/routing.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['*.apiKey', '*.token', '*.secret', '*.password'],
});

export function logRoutingDecision(result: RouteResult, elapsedMs: number): void {
  logger.info({
    event: 'routing_decision',
    intent: result.intent,
    confidenceScore: result.confidenceScore,
    targetAgent: result.agentId,
    isFallback: result.isFallback,
    elapsedMs,
  });
}

export function logSecurityEvent(
  event: 'prompt_injection_detected',
  details: Record<string, unknown>,
): void {
  logger.warn({ event, ...details });
}

export function logToolStrippingEvent(details: { agentId: string; orgId: string; intent: string }): void {
  logger.info({ event: 'tool_stripping_activated', ...details });
}

export function logAdministrativeIntentClarificationEvent(details: { confidenceScore: number; channelId: string; userName: string }): void {
  logger.info({ event: 'administrative_intent_clarification_triggered', ...details });
}

export function logAdrEvent(
  event: 'adr_auto_drafted' | 'adr_human_approved' | 'duplicate_proposal_prevented',
  details: Record<string, unknown>,
): void {
  logger.info({ event, ...details });
}

export function logEvalMetrics(metrics: {
  accuracy: number;
  drift: number;
  total: number;
  correct: number;
  adminAvgConfidence: number;
  failedIds: string[];
}): void {
  logger.info({ event: 'intent_eval_accuracy', accuracy: metrics.accuracy, total: metrics.total, correct: metrics.correct, failedIds: metrics.failedIds });
  logger.info({ event: 'intent_eval_drift', drift: metrics.drift, adminAvgConfidence: metrics.adminAvgConfidence, adminConfidenceGate: 0.6, accuracyGate: 0.95 });
}
