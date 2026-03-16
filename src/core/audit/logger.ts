import pino from 'pino';

const logger = pino({ level: 'info' });

export interface AuditMutationEvent {
  timestamp: string;
  toolName: string;
  agentId: string;
  settingKey: string;
  previousValue: unknown;
  newValue: unknown;
  context?: Record<string, unknown>;
}

export interface AuditRejectionEvent {
  timestamp: string;
  toolName: string;
  agentId: string;
  settingKey: string;
  error: 'FORBIDDEN_KEY' | 'RATE_LIMITED';
  retryAfterMs?: number;
}

export function logSettingMutation(event: AuditMutationEvent): void {
  logger.info(event);
}

export function logSettingRejection(event: AuditRejectionEvent): void {
  logger.warn(event);
}
