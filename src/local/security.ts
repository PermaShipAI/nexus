import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

// ── Session token for local UI auth ─────────────────────────────────────────

let sessionToken: string | null = null;

/** Generate a session token on startup (displayed in terminal) */
export function generateSessionToken(): string {
  sessionToken = randomBytes(24).toString('hex');
  return sessionToken;
}

/** Validate a session token from request */
export function validateSession(token: string | undefined): boolean {
  if (!sessionToken) return true; // No token generated = auth disabled
  return token === sessionToken;
}

/** Extract token from request (cookie or header) */
export function extractToken(request: any): string | undefined {
  // Check Authorization header
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

  // Check cookie
  const cookies = request.headers.cookie;
  if (cookies) {
    const match = cookies.match(/nc_session=([^;]+)/);
    if (match) return match[1];
  }

  // Check query param (for WebSocket handshake)
  const url = new URL(request.url, 'http://localhost');
  return url.searchParams.get('token') ?? undefined;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

// ── Origin validation ───────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isAllowedOrigin(request: any): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // Same-origin requests don't send Origin header

  try {
    const url = new URL(origin);
    return ALLOWED_ORIGINS.has(url.hostname);
  } catch {
    return false;
  }
}

// ── Secrets encryption ──────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getDerivedKey(): Buffer {
  // Derive a key from machine-specific data
  // In production, use a proper key management service
  const seed = process.env.ENCRYPTION_KEY ?? `nc-${process.cwd()}-${process.env.USER ?? 'local'}`;
  return createHash('sha256').update(seed).digest();
}

/** Encrypt a plaintext value */
export function encryptValue(plaintext: string): string {
  const key = getDerivedKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/** Decrypt an encrypted value */
export function decryptValue(encoded: string): string {
  const key = getDerivedKey();
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ── Secure file operations ──────────────────────────────────────────────────

/** Write a file with restricted permissions (owner-only read/write) */
export function writeFileSecure(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
}

/** Create a directory with restricted permissions */
export function mkdirSecure(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

// ── Path validation ─────────────────────────────────────────────────────────

import { resolve, normalize } from 'node:path';
import { realpathSync } from 'node:fs';

/** Validate that a path is a real directory and not a traversal attack */
export function validateProjectPath(localPath: string): { valid: boolean; resolved: string; error?: string } {
  try {
    const resolved = resolve(localPath);
    const normalized = normalize(resolved);

    // Block obvious dangerous paths
    const dangerous = ['/etc', '/root', '/var', '/usr', '/bin', '/sbin', '/proc', '/sys', '/dev'];
    for (const d of dangerous) {
      if (normalized === d || normalized.startsWith(d + '/')) {
        return { valid: false, resolved: normalized, error: 'Path points to a system directory' };
      }
    }

    // Resolve symlinks to prevent traversal
    const real = realpathSync(resolved);
    return { valid: true, resolved: real };
  } catch (err) {
    return { valid: false, resolved: localPath, error: `Invalid path: ${(err as Error).message}` };
  }
}

// ── Git URL validation ──────────────────────────────────────────────────────

export function validateGitUrl(url: string): { valid: boolean; error?: string } {
  // Only allow https, http, git, and ssh protocols
  if (!url.match(/^(https?|git|ssh):\/\//)) {
    return { valid: false, error: 'URL must use https, http, git, or ssh protocol' };
  }
  // Block file:// and local paths
  if (url.startsWith('file://') || url.startsWith('/') || url.startsWith('.')) {
    return { valid: false, error: 'Local file URLs are not allowed' };
  }
  return { valid: true };
}

// ── Prompt sanitization ─────────────────────────────────────────────────────

/** Sanitize ticket content for inclusion in execution prompts */
export function sanitizeForPrompt(text: string, maxLength = 2000): string {
  return text
    // Collapse excessive newlines
    .replace(/\n{3,}/g, '\n\n')
    // Strip characters that could be used for prompt injection markers
    .replace(/^#{1,6}\s+/gm, '') // Remove markdown headings that could override prompt structure
    .slice(0, maxLength)
    .trim();
}
