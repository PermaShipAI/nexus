import { logger } from '../telemetry/logger.js';

export type LockReason = 'rbac_rejection' | 'security_refusal';

// Default TTL: 1 hour. Override via INTENT_LOCK_TTL_MS env var.
const LOCK_TTL_MS = parseInt(process.env.INTENT_LOCK_TTL_MS ?? '3600000', 10);

interface LockEntry {
  lockedAt: Date;
  reason: LockReason;
}

const lockStore = new Map<string, LockEntry>();

export const CIRCUIT_BREAKER_MESSAGE =
  'Security Policy Check: Request previously denied. Interaction terminated.';

export function lockIntent(sessionId: string, intent: string, reason: LockReason): void {
  lockStore.set(`${sessionId}:${intent}`, { lockedAt: new Date(), reason });
  logger.warn({ event: 'circuit_breaker.intent_locked', sessionId, intent, reason });
}

export function isIntentLocked(sessionId: string, intent: string): boolean {
  const key = `${sessionId}:${intent}`;
  const entry = lockStore.get(key);
  if (!entry) return false;
  if (Date.now() - entry.lockedAt.getTime() > LOCK_TTL_MS) {
    lockStore.delete(key);
    return false;
  }
  return true;
}

export function clearSessionLocks(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of lockStore.keys()) {
    if (key.startsWith(prefix)) {
      lockStore.delete(key);
    }
  }
}

export function _resetLockStore(): void {
  lockStore.clear();
}
