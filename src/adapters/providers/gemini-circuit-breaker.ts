import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { geminiCbTransitionsTotal, geminiCbRejectedTotal } from '../../telemetry/prometheus.js';

export class GeminiCircuitOpenError extends Error {
  constructor() {
    super('Gemini circuit breaker is open — request fast-failed');
    this.name = 'GeminiCircuitOpenError';
  }
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class GeminiCircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private readonly tripThreshold: number;
  private readonly resetWindowMs: number;

  constructor() {
    this.tripThreshold = config.LLM_CB_TRIP_THRESHOLD;
    this.resetWindowMs = config.LLM_CB_RESET_WINDOW_MS;
  }

  getState(): CircuitState {
    if (this.openedAt === null) return 'CLOSED';
    if (Date.now() - this.openedAt >= this.resetWindowMs) return 'HALF_OPEN';
    return 'OPEN';
  }

  isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  recordSuccess(): void {
    const prev = this.getState();
    if (prev !== 'CLOSED') {
      this.openedAt = null;
      this.consecutiveFailures = 0;
      this._transition(prev, 'CLOSED');
    } else {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(err: unknown): void {
    if (!isRetriableForBreaker(err)) return;
    const prev = this.getState();
    this.consecutiveFailures++;
    if (prev === 'HALF_OPEN' || this.consecutiveFailures >= this.tripThreshold) {
      const wasOpen = prev === 'OPEN';
      this.openedAt = Date.now();
      if (!wasOpen) {
        this._transition(prev, 'OPEN');
      } else {
        // Reset timestamp on re-trip from HALF_OPEN probe failure
        logger.warn(
          { event: 'gemini_circuit_breaker_open', consecutiveFailures: this.consecutiveFailures },
          'Gemini circuit breaker probe failed — reset open window',
        );
      }
    }
  }

  /** Exposed for test teardown only */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private _transition(from: CircuitState, to: CircuitState): void {
    geminiCbTransitionsTotal.inc({ from_state: from, to_state: to });
    const level = to === 'OPEN' ? 'warn' : 'info';
    const event = to === 'OPEN' ? 'gemini_circuit_breaker_open' : 'gemini_circuit_breaker_closed';
    logger[level](
      { event, from_state: from, to_state: to, consecutiveFailures: this.consecutiveFailures, openedAt: this.openedAt },
      `Gemini circuit breaker transitioned ${from} → ${to}`,
    );
  }
}

function isRetriableForBreaker(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as unknown as { status?: number }).status;
  if (typeof status === 'number') return status === 429 || (status >= 500 && status < 600);
  return (
    err.message.includes('fetch failed') ||
    err.message.includes('ECONNRESET') ||
    err.message.includes('ETIMEDOUT') ||
    err.message.includes('ENOTFOUND') ||
    /\b(429|5\d{2})\b/.test(err.message)
  );
}

export const geminiCircuitBreaker = new GeminiCircuitBreaker();

// Re-export for consumers that only need the rejected counter
export { geminiCbRejectedTotal };
