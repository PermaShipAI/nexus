import { logger } from '../../logger.js';
import { llmCircuitBreakerTrippedTotal } from '../../telemetry/prometheus.js';

export class BudgetExhaustedError extends Error {
  provider: string;
  modelTier: string;
  errorStatus: string;

  constructor(provider: string, modelTier: string, errorStatus: string, cause?: unknown) {
    super(`LLM retry budget exhausted for provider=${provider} modelTier=${modelTier}`);
    this.name = 'BudgetExhaustedError';
    this.provider = provider;
    this.modelTier = modelTier;
    this.errorStatus = errorStatus;
    if (cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = cause;
    }
  }
}

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
  circuitBreaker?: boolean;
  cbProvider?: string;
  cbModelTier?: string;
}

const DEFAULTS: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitterFactor: 0.2,
  circuitBreaker: false,
  cbProvider: 'unknown',
  cbModelTier: 'unknown',
};

/**
 * Returns true if the error is transient and worth retrying:
 * - HTTP 429 (rate limit)
 * - HTTP 5xx (server errors)
 * - Network connectivity errors
 */
function isRetriable(err: unknown): boolean {
  if (err instanceof Error) {
    // Anthropic and OpenAI SDKs expose a `status` property
    const status = (err as unknown as { status?: number }).status;
    if (typeof status === 'number') {
      return status === 429 || (status >= 500 && status < 600);
    }

    // Ollama throws plain Error with message "Ollama error <status>: ..."
    const match = err.message.match(/\b(429|5\d{2})\b/);
    if (match) return true;

    // Network-level errors (fetch failures, ECONNRESET, etc.)
    if (
      err.message.includes('fetch failed') ||
      err.message.includes('ECONNRESET') ||
      err.message.includes('ETIMEDOUT') ||
      err.message.includes('ENOTFOUND') ||
      err.message.includes('network')
    ) {
      return true;
    }
  }
  return false;
}

function getErrorStatus(err: unknown): number | string | undefined {
  if (err instanceof Error) {
    const status = (err as unknown as { status?: number }).status;
    if (typeof status === 'number') return status;
    const match = err.message.match(/\b(429|5\d{2})\b/);
    if (match) return match[1];
  }
  return undefined;
}

function computeDelay(attempt: number, config: Required<RetryConfig>): number {
  const base = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const capped = Math.min(base, config.maxDelayMs);
  // Full jitter: random in [0, capped * (1 + jitterFactor)]
  const jitter = capped * config.jitterFactor * Math.random();
  return Math.round(capped + jitter);
}

/**
 * Wraps an async operation with exponential backoff and jitter.
 * Only retries on transient errors (429, 5xx, network failures).
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config?: RetryConfig,
  context?: string,
): Promise<T> {
  const cfg = { ...DEFAULTS, ...config };
  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;

      if (attempt === cfg.maxRetries || !isRetriable(err)) {
        if (cfg.circuitBreaker && attempt === cfg.maxRetries && isRetriable(err)) {
          const errorStatus = String(getErrorStatus(err) ?? 'unknown');
          llmCircuitBreakerTrippedTotal.inc({
            provider: cfg.cbProvider ?? 'unknown',
            model_tier: cfg.cbModelTier ?? 'unknown',
            error_status: errorStatus,
          });
          logger.warn(
            { provider: cfg.cbProvider, modelTier: cfg.cbModelTier, context, errorStatus },
            'LLM circuit breaker tripped: retry budget exhausted',
          );
          throw new BudgetExhaustedError(
            cfg.cbProvider ?? 'unknown',
            cfg.cbModelTier ?? 'unknown',
            errorStatus,
            err,
          );
        }
        throw err;
      }

      const delayMs = computeDelay(attempt, cfg);
      const status = (err instanceof Error)
        ? (err as unknown as { status?: number }).status
        : undefined;

      logger.warn(
        { attempt: attempt + 1, maxRetries: cfg.maxRetries, delayMs, status, context },
        'LLM API call failed, retrying with exponential backoff',
      );

      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
