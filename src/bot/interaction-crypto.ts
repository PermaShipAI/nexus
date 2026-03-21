import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const TOKEN_TTL_MS = 300_000; // 5 minutes
const HMAC_HEX_CHARS = 32;

function getSigningKey(): string {
  const key = config.WEBHOOK_SIGNING_SECRET ?? config.INTERNAL_SECRET;
  if (!key) {
    // M7: Use a random key if none configured (local-only mode)
    // This ensures signatures are cryptographically valid but session-scoped
    if (!_fallbackKey) _fallbackKey = randomBytes(32).toString('hex');
    return _fallbackKey!;
  }
  return key;
}
let _fallbackKey: string | undefined;

export function buildSignedCustomId(prefix: string, actionId: string): string {
  const timestamp = Date.now().toString();
  const signingKey = getSigningKey();
  const hmac = createHmac('sha256', signingKey)
    .update(`${actionId}:${timestamp}`)
    .digest('hex')
    .slice(0, HMAC_HEX_CHARS);
  return `${prefix}:${actionId}:${timestamp}:${hmac}`;
}

export function verifySignedCustomId(customId: string): { valid: boolean; actionId?: string; reason?: string } {
  const signingKey = getSigningKey();
  if (!signingKey) {
    return { valid: false, reason: 'no_signing_key' };
  }

  const parts = customId.split(':');
  if (parts.length !== 4) {
    return { valid: false, reason: 'malformed_custom_id' };
  }

  const [, actionId, timestampStr, receivedHmac] = parts;
  const timestamp = parseInt(timestampStr, 10);
  const now = Date.now();

  if (isNaN(timestamp) || timestamp > now || now - timestamp > TOKEN_TTL_MS) {
    return { valid: false, reason: 'token_expired' };
  }

  const expectedHmac = createHmac('sha256', signingKey)
    .update(`${actionId}:${timestampStr}`)
    .digest('hex')
    .slice(0, HMAC_HEX_CHARS);

  const receivedBuf = Buffer.from(receivedHmac, 'utf8');
  const expectedBuf = Buffer.from(expectedHmac, 'utf8');

  if (receivedBuf.length !== expectedBuf.length || !timingSafeEqual(receivedBuf, expectedBuf)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  return { valid: true, actionId };
}
