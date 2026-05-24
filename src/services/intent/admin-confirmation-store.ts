import { randomUUID } from 'crypto';

export interface PendingAdminAction {
  id: string;
  orgId: string;
  channelId: string;
  settingKey: string;
  settingValue: string;
  requestingUserId: string;
  requestingUserName: string;
  platform: 'discord' | 'slack';
  createdAt: Date;
  expiresAt: Date;
}

const store = new Map<string, PendingAdminAction>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createPendingAdminAction(
  params: Omit<PendingAdminAction, 'id' | 'createdAt' | 'expiresAt'>,
): PendingAdminAction {
  const now = new Date();
  const action: PendingAdminAction = {
    ...params,
    id: randomUUID(),
    createdAt: now,
    expiresAt: new Date(now.getTime() + TTL_MS),
  };
  store.set(action.id, action);
  return action;
}

export function getPendingAdminAction(id: string): PendingAdminAction | undefined {
  const action = store.get(id);
  if (!action) return undefined;
  if (new Date() > action.expiresAt) {
    store.delete(id);
    return undefined;
  }
  return action;
}

export function removePendingAdminAction(id: string): void {
  store.delete(id);
}

// Export store for testing
export { store as pendingAdminActionStore };

// Cleanup interval — unref'd so it doesn't prevent process exit in tests
const cleanupInterval = setInterval(() => {
  const now = new Date();
  for (const [id, action] of store.entries()) {
    if (now > action.expiresAt) {
      store.delete(id);
    }
  }
}, 60_000);

if (cleanupInterval.unref) {
  cleanupInterval.unref();
}
