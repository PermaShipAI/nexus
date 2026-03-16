import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { secrets, type NewSecret, type Secret } from '../db/schema.js';
import { logger } from '../logger.js';
import { encryptValue, decryptValue } from '../local/security.js';
import type { AgentId } from '../agents/types.js';

const ENCRYPTED_PREFIX = 'enc:';

function encrypt(value: string): string {
  try {
    return ENCRYPTED_PREFIX + encryptValue(value);
  } catch {
    // If encryption fails (e.g., in test env), store plaintext
    return value;
  }
}

function decrypt(value: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // Legacy plaintext
  try {
    return decryptValue(value.slice(ENCRYPTED_PREFIX.length));
  } catch {
    logger.warn('Failed to decrypt secret value — may be from a different installation');
    return value;
  }
}

export async function setSecret(secret: NewSecret): Promise<Secret> {
  const encryptedValue = encrypt(secret.value);

  const [existing] = await db
    .select()
    .from(secrets)
    .where(and(eq(secrets.key, secret.key), eq(secrets.environment, secret.environment ?? 'production')))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(secrets)
      .set({ value: encryptedValue, agentId: secret.agentId, updatedAt: new Date() })
      .where(eq(secrets.id, existing.id))
      .returning();
    logger.info({ key: secret.key, env: secret.environment }, 'Updated secret');
    return updated;
  }

  const [inserted] = await db.insert(secrets).values({ ...secret, value: encryptedValue }).returning();
  logger.info({ key: secret.key, env: secret.environment }, 'Stored new secret');
  return inserted;
}

export async function getSecret(key: string, environment = 'production', agentId?: AgentId): Promise<string | null> {
  const [secret] = await db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.key, key),
        eq(secrets.environment, environment),
        agentId ? eq(secrets.agentId, agentId) : sql`TRUE`,
      )
    )
    .limit(1);

  if (!secret) return null;
  return decrypt(secret.value);
}
