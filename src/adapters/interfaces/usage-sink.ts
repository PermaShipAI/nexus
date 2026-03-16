export interface UsagePayload {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  windowStartedAt: string;
}

export interface UsageSink {
  reportUsage(orgId: string, payload: UsagePayload): Promise<void>;
}
