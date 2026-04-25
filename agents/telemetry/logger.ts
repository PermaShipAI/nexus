import pino from 'pino';
import type { RouteResult } from '../types/routing.js';
import {
  routingRequestsTotal,
  routingLatencyMs,
  routingConfidenceScore,
  routingInjectionBlockedTotal,
  agentInvalidStateTransitionBlockedTotal,
} from '../../src/telemetry/prometheus.js';

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

  const isFallback = String(result.isFallback ?? false);
  const isCircuitBroken = String(result.isCircuitBroken ?? false);

  routingRequestsTotal.inc({
    intent: result.intent,
    agent_id: result.agentId,
    is_fallback: isFallback,
    is_circuit_broken: isCircuitBroken,
  });

  routingLatencyMs.observe({ intent: result.intent, is_fallback: isFallback }, elapsedMs);

  if (result.confidenceScore >= 0) {
    routingConfidenceScore.observe({ intent: result.intent }, result.confidenceScore);
  }
}

export function logSecurityEvent(
  event: 'prompt_injection_detected',
  details: Record<string, unknown>,
): void {
  logger.warn({ event, ...details });
  routingInjectionBlockedTotal.inc();
}

export function logToolStrippingEvent(details: { agentId: string; orgId: string; intent: string }): void {
  logger.info({ event: 'tool_stripping_activated', ...details });
}

export function logInvalidStateTransitionBlocked(details: {
  agentId?: string;
  orgId: string;
  taskId: string;
  requestedStatus: string;
}): void {
  logger.warn({ event: 'agent_invalid_state_transition_blocked', ...details });
  agentInvalidStateTransitionBlockedTotal.inc({
    agent_id: details.agentId ?? 'unknown',
    requested_status: details.requestedStatus,
  });
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
