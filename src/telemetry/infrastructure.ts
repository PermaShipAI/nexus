import { logger } from '../logger.js';

/**
 * Emitted when a circuit breaker transitions CLOSED → OPEN.
 * Required fields per PRD section 3.4.
 */
export function logCircuitBreakerTripped(details: {
  dependency: string;
  reason: string;
  tripCount: number;
}): void {
  logger.warn({
    event: 'circuit_breaker_tripped',
    timestamp: new Date().toISOString(),
    ...details,
  });
}

/**
 * Emitted when a circuit breaker transitions OPEN → CLOSED after recovery.
 * Required fields per PRD section 3.4.
 */
export function logCircuitBreakerReset(details: {
  dependency: string;
  downtimeSeconds: number;
}): void {
  logger.info({
    event: 'circuit_breaker_reset',
    timestamp: new Date().toISOString(),
    ...details,
  });
}

/**
 * Emitted when any circuit breaker enters the OPEN state.
 * Required fields per PRD section 3.4.
 */
export function logDegradedModeActive(details: {
  affectedDependencies: string[];
}): void {
  logger.warn({
    event: 'degraded_mode_active',
    timestamp: new Date().toISOString(),
    ...details,
  });
}

/**
 * Emitted when all circuit breakers have returned to CLOSED state.
 * Required fields per PRD section 3.4.
 */
export function logDegradedModeCleared(): void {
  logger.info({
    event: 'degraded_mode_cleared',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emitted each time a request is rejected because a dependency circuit
 * breaker is OPEN.  Required fields per PRD section 3.4.
 */
export function logRequestRejectedDegraded(details: {
  dependency: string;
  endpoint: string;
}): void {
  logger.warn({
    event: 'request_rejected_degraded',
    timestamp: new Date().toISOString(),
    ...details,
  });
}
