import { config } from '../config.js';
import { logger } from '../logger.js';
import { getUsageSink } from '../adapters/registry.js';

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface OrgBuffer {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  windowStartedAt: string;
}

export class UsageReporter {
  private buffers: Map<string, OrgBuffer> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  record(orgId: string, usage: TokenUsage): void {
    const existing = this.buffers.get(orgId);
    if (existing) {
      existing.inputTokens += usage.inputTokens;
      existing.outputTokens += usage.outputTokens;
      existing.turns += 1;
    } else {
      this.buffers.set(orgId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        turns: 1,
        windowStartedAt: new Date().toISOString(),
      });
    }
    const buf = this.buffers.get(orgId)!;
    if (buf.turns >= config.USAGE_FLUSH_TURN_THRESHOLD) {
      void this.flush(orgId);
    }
  }

  async flush(orgId: string): Promise<void> {
    const buf = this.buffers.get(orgId);
    if (!buf) return;
    this.buffers.delete(orgId);
    const start = Date.now();
    try {
      await getUsageSink().reportUsage(orgId, buf);
      logger.info({ event: 'usage_reporter.flush', orgId, inputTokens: buf.inputTokens, outputTokens: buf.outputTokens, turns: buf.turns, durationMs: Date.now() - start, status: 'ok' });
    } catch (err) {
      logger.error({ event: 'usage_reporter.flush_error', orgId, err });
    }
  }

  async flushAll(): Promise<void> {
    const orgIds = Array.from(this.buffers.keys());
    await Promise.allSettled(orgIds.map((orgId) => this.flush(orgId)));
  }

  start(): void {
    // On SIGKILL, buffered data for the current window is lost (bounded to one flush interval)
    this.timer = setInterval(() => {
      void this.flushAll();
    }, config.USAGE_FLUSH_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flushAll();
  }
}

export const usageReporter = new UsageReporter();
