import { createHash, randomBytes } from 'crypto';

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface StoredToken {
  hash: string;
  userId: string;
  expiresAt: number;
  used: boolean;
}

// In-memory store — replace with database in production
const tokenStore = new Map<string, StoredToken>();

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function generateLinkToken(userId: string): string {
  const rawToken = randomBytes(32).toString('hex');
  const hash = hashToken(rawToken);
  const expiresAt = Date.now() + TOKEN_TTL_MS;

  tokenStore.set(hash, {
    hash,
    userId,
    expiresAt,
    used: false,
  });

  return rawToken; // Raw token sent to user; only hash stored
}

export function consumeLinkToken(
  rawToken: string,
): { userId: string } | null {
  const hash = hashToken(rawToken);
  const stored = tokenStore.get(hash);

  if (!stored) return null;
  if (stored.used) return null;
  if (Date.now() > stored.expiresAt) {
    tokenStore.delete(hash);
    return null;
  }

  // Mark as used (one-time-use)
  stored.used = true;
  tokenStore.set(hash, stored);

  return { userId: stored.userId };
}

export function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [hash, token] of tokenStore.entries()) {
    if (now > token.expiresAt) {
      tokenStore.delete(hash);
    }
  }
}
