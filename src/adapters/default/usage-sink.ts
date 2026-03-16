import type { UsageSink, UsagePayload } from '../interfaces/usage-sink.js';

/**
 * Console-based usage sink for standalone use.
 * Logs usage metrics to stdout instead of reporting to an external service.
 */
export class ConsoleUsageSink implements UsageSink {
  async reportUsage(orgId: string, payload: UsagePayload): Promise<void> {
    console.log(
      `[USAGE] org=${orgId} input=${payload.inputTokens} output=${payload.outputTokens} turns=${payload.turns}`,
    );
  }
}
