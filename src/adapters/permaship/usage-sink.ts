import { reportUsage } from '../../permaship/client.js';
import type { UsageSink, UsagePayload } from '../interfaces/usage-sink.js';

export class PermashipUsageSink implements UsageSink {
  async reportUsage(orgId: string, payload: UsagePayload): Promise<void> {
    return reportUsage(orgId, payload);
  }
}
