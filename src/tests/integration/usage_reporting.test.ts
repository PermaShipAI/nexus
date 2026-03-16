import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReportUsage = vi.fn().mockResolvedValue(undefined);

vi.mock('../../adapters/registry.js', () => ({
  getUsageSink: () => ({
    reportUsage: mockReportUsage,
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    USAGE_FLUSH_INTERVAL_MS: 60000,
    USAGE_FLUSH_TURN_THRESHOLD: 100,
  },
}));

import { UsageReporter } from '../../telemetry/usage-reporter.js';
import { logger } from '../../logger.js';

describe('UsageReporter integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accumulates 5 turns and flushes correct totals', async () => {
    const reporter = new UsageReporter();

    for (let i = 0; i < 5; i++) {
      reporter.record('org-abc', { inputTokens: 100, outputTokens: 50 });
    }

    await reporter.flushAll();

    expect(mockReportUsage).toHaveBeenCalledOnce();
    expect(mockReportUsage).toHaveBeenCalledWith('org-abc', {
      inputTokens: 500,
      outputTokens: 250,
      turns: 5,
      windowStartedAt: expect.any(String),
    });
  });

  it('does not call reportUsage when buffer is empty', async () => {
    const reporter = new UsageReporter();

    await reporter.flushAll();

    expect(mockReportUsage).not.toHaveBeenCalled();
  });

  it('logs error and does not throw when reportUsage rejects', async () => {
    mockReportUsage.mockRejectedValue(new Error('network error'));

    const reporter = new UsageReporter();
    reporter.record('org-xyz', { inputTokens: 10, outputTokens: 5 });

    await expect(reporter.flushAll()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});
