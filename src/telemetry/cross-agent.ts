import { logger } from '../../agents/telemetry/logger.js';

/**
 * Emitted when Nexus deduplicates a proposal against an existing ticket.
 * This captures the "conflict resolved" state for observability.
 */
export function logCrossAgentConflictResolved(details: {
  orgId: string;
  proposingAgentId: string;
  newTitle: string;
  matchedTitle: string;
}): void {
  logger.info({
    event: 'cross_agent_conflict_resolved',
    ...details,
  });
}

/**
 * Emitted when a cross-agent review times out (secondary agent did not
 * respond within the allowed window).
 */
export function logAgentReviewTimeout(details: {
  orgId: string;
  proposingAgentId: string;
  reviewerAgentId: string;
  timeoutMs: number;
  proposalId?: string;
}): void {
  logger.warn({
    event: 'cross_agent_review_timeout',
    state: 'skipped_due_to_timeout',
    ...details,
  });
}

/**
 * Emitted when the inter-agent review circuit breaker trips (cycle count
 * exceeds the maximum allowed iterations), escalating to human review.
 */
export function logCircuitBreakerTripped(details: {
  orgId: string;
  proposalId: string;
  agentId: string;
  cycleCount: number;
  maxCycles: number;
}): void {
  logger.warn({
    event: 'cross_agent_circuit_breaker_tripped',
    state: 'waiting_for_human',
    ...details,
  });
}

/**
 * Emitted when an agent attempts to act on a ticket/item that is locked in
 * the `waiting_for_human` state, preventing the bypass.
 */
export function logWaitingForHumanBlock(details: {
  orgId: string;
  agentId: string;
  actionId: string;
  actionType: string;
}): void {
  logger.warn({
    event: 'preflight_waiting_for_human_blocked',
    state: 'waiting_for_human',
    ...details,
  });
}
