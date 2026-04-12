import { randomBytes } from 'node:crypto';

export interface AdminClarificationState {
  orgId: string;
  channelId: string;
  authorId: string;
  settingKey: string | undefined;
  expiresAt: number;
}

const CLARIFICATION_TTL_MS = 60_000;
const store = new Map<string, AdminClarificationState>();

export function storeClarification(
  state: Omit<AdminClarificationState, 'expiresAt'>,
): string {
  const id = randomBytes(4).toString('hex'); // 8-char hex
  store.set(id, { ...state, expiresAt: Date.now() + CLARIFICATION_TTL_MS });
  return id;
}

export function getClarification(id: string): AdminClarificationState | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(id);
    return null;
  }
  return entry;
}

export function deleteClarification(id: string): void {
  store.delete(id);
}
