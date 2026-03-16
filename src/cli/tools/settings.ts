import { validateSettingKey } from '../../core/guardrails/settings_validator.js';
import { SettingsMutationRateLimiter } from '../../core/guardrails/rate_limiter.js';
import { settingsStore } from '../../core/settings_store.js';
import { logSettingMutation, logSettingRejection } from '../../core/audit/logger.js';
import type { AuditMutationEvent } from '../../core/audit/logger.js';

export interface SetSettingParams {
  key: string;
  value: unknown;
  agentId: string;
  context?: Record<string, unknown>;
}

export interface GetSettingParams {
  key: string;
  agentId: string;
}

export type ToolResult =
  | { success: true; key: string; previousValue: unknown; newValue: unknown }
  | { success: true; key: string; value: unknown }
  | { success: false; error: string; message: string; retryAfterMs?: number };

const rateLimiter = new SettingsMutationRateLimiter();

export async function setSettingTool(params: SetSettingParams): Promise<ToolResult> {
  const { key, value, agentId, context } = params;

  const validation = validateSettingKey(key);
  if (!validation.valid) {
    logSettingRejection({
      timestamp: new Date().toISOString(),
      toolName: 'set-setting',
      agentId,
      settingKey: key,
      error: 'FORBIDDEN_KEY',
    });
    return {
      success: false,
      error: validation.error,
      message: validation.message,
    };
  }

  const rateLimit = rateLimiter.check(key);
  if (!rateLimit.allowed) {
    logSettingRejection({
      timestamp: new Date().toISOString(),
      toolName: 'set-setting',
      agentId,
      settingKey: key,
      error: 'RATE_LIMITED',
      retryAfterMs: rateLimit.retryAfterMs,
    });
    return {
      success: false,
      error: 'RATE_LIMITED',
      message: `Setting "${key}" was mutated too recently. Retry after ${rateLimit.retryAfterMs} ms.`,
      retryAfterMs: rateLimit.retryAfterMs,
    };
  }

  const previousValue = settingsStore.get(key);
  settingsStore.set(key, value);
  rateLimiter.record(key);

  const mutationEvent: AuditMutationEvent = {
    timestamp: new Date().toISOString(),
    toolName: 'set-setting',
    agentId,
    settingKey: key,
    previousValue,
    newValue: value,
  };
  if (context !== undefined) {
    mutationEvent.context = context;
  }
  logSettingMutation(mutationEvent);

  return { success: true, key, previousValue, newValue: value };
}

export async function getSettingTool(params: GetSettingParams): Promise<ToolResult> {
  const { key } = params;

  const validation = validateSettingKey(key);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      message: validation.message,
    };
  }

  const value = settingsStore.get(key);
  return { success: true, key, value };
}
