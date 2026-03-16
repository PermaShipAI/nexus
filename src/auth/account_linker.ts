import { Role } from '../rbac/types.js';

export interface LinkedAccount {
  platform: 'discord' | 'slack';
  platformUserId: string;
  userId: string;
  role: Role;
  linkedAt: number;
}

export interface LinkStatus {
  linked: boolean;
  userId?: string;
}

// In-memory store — replace with database in production
const linkedAccounts = new Map<string, LinkedAccount>();

function makeKey(platform: string, platformUserId: string): string {
  return `${platform}:${platformUserId}`;
}

export function linkAccount(
  platform: 'discord' | 'slack',
  platformUserId: string,
  userId: string,
  role: Role = 'VIEWER',
): { linked: true; userId: string } | { error: 'AlreadyLinked'; existingUserId: string } {
  const key = makeKey(platform, platformUserId);
  const existing = linkedAccounts.get(key);

  if (existing) {
    // Return the caller's own existing link — never a third party's
    return {
      error: 'AlreadyLinked',
      existingUserId: existing.userId,
    };
  }

  linkedAccounts.set(key, {
    platform,
    platformUserId,
    userId,
    role,
    linkedAt: Date.now(),
  });

  return { linked: true, userId };
}

export function unlinkAccount(
  platform: 'discord' | 'slack',
  platformUserId: string,
  requestingUserId: string,
  requestingRole: Role,
): { unlinked: true } | { error: 'Forbidden' } | { error: 'NotFound' } {
  const key = makeKey(platform, platformUserId);
  const existing = linkedAccounts.get(key);

  if (!existing) {
    return { error: 'NotFound' };
  }

  const isOwner = existing.userId === requestingUserId;
  const isAdmin = requestingRole === 'ADMIN' || requestingRole === 'OWNER';

  if (!isOwner && !isAdmin) {
    return { error: 'Forbidden' };
  }

  linkedAccounts.delete(key);
  return { unlinked: true };
}

export function getLinkStatus(
  platform: 'discord' | 'slack',
  platformUserId: string,
): LinkStatus {
  const key = makeKey(platform, platformUserId);
  const existing = linkedAccounts.get(key);

  if (!existing) {
    return { linked: false };
  }

  return { linked: true, userId: existing.userId };
}

export function getLinkedAccount(
  platform: 'discord' | 'slack',
  platformUserId: string,
): LinkedAccount | null {
  const key = makeKey(platform, platformUserId);
  return linkedAccounts.get(key) ?? null;
}
