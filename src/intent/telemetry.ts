import pino from 'pino';

const logger = pino({ name: 'intent-router' });

export interface RoutingDecision {
  messageId: string;
  intentKind: string;
  confidenceScore: number;
  allowed: boolean;
  blockReason?: string;
  channelType: string;
  platform: string;
  durationMs: number;
  timestamp: string;
}

export function logRoutingDecision(decision: RoutingDecision): void {
  const level = decision.allowed ? 'info' : 'warn';
  logger[level](decision, 'routing_decision');
}
