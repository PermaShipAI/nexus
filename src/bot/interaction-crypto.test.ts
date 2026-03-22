import '../tests/env.js';
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildSignedCustomId, verifySignedCustomId } from './interaction-crypto.js';

describe('interaction-crypto', () => {
  describe('verifySignedCustomId – valid tokens', () => {
    it('accepts a freshly built token', () => {
      const token = buildSignedCustomId('btn', 'approve');
      const result = verifySignedCustomId(token);
      expect(result.valid).toBe(true);
      expect(result.actionId).toBe('approve');
    });

    it('returns the correct actionId on success', () => {
      const token = buildSignedCustomId('modal', 'submit_form');
      const result = verifySignedCustomId(token);
      expect(result.valid).toBe(true);
      expect(result.actionId).toBe('submit_form');
    });
  });

  describe('verifySignedCustomId – malformed payloads', () => {
    it('rejects an empty string', () => {
      const result = verifySignedCustomId('');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('malformed_custom_id');
    });

    it('rejects a token with too few segments', () => {
      const result = verifySignedCustomId('prefix:actionId:timestamp');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('malformed_custom_id');
    });

    it('rejects a token with too many segments', () => {
      const result = verifySignedCustomId('prefix:actionId:timestamp:hmac:extra');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('malformed_custom_id');
    });

    it('rejects a token with a non-numeric timestamp', () => {
      const result = verifySignedCustomId('prefix:actionId:notANumber:deadbeefdeadbeefdeadbeefdeadbeef');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('token_expired');
    });

    it('rejects a token whose timestamp is zero', () => {
      const result = verifySignedCustomId('prefix:actionId:0:deadbeefdeadbeefdeadbeefdeadbeef');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('token_expired');
    });
  });

  describe('verifySignedCustomId – invalid HMAC signatures', () => {
    it('rejects a token with a tampered HMAC', () => {
      const token = buildSignedCustomId('btn', 'delete');
      const parts = token.split(':');
      // Flip the last character of the HMAC to corrupt it
      const lastChar = parts[3].slice(-1);
      parts[3] = parts[3].slice(0, -1) + (lastChar === 'a' ? 'b' : 'a');
      const result = verifySignedCustomId(parts.join(':'));
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_signature');
    });

    it('rejects a token with a completely wrong HMAC', () => {
      const token = buildSignedCustomId('btn', 'delete');
      const parts = token.split(':');
      parts[3] = '0'.repeat(32);
      const result = verifySignedCustomId(parts.join(':'));
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_signature');
    });

    it('rejects a token with an HMAC from a different signing key', () => {
      // Build with current key then fake-change the HMAC to what a different key would produce
      const token = buildSignedCustomId('btn', 'escalate');
      const parts = token.split(':');
      // Produce a valid-looking HMAC but with the wrong key
      
      const wrongHmac = createHmac('sha256', 'wrong-key').update(`${parts[1]}:${parts[2]}`).digest('hex').slice(0, 32);
      parts[3] = wrongHmac;
      const result = verifySignedCustomId(parts.join(':'));
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_signature');
    });

    it('rejects a token with a tampered actionId (HMAC no longer matches payload)', () => {
      const token = buildSignedCustomId('btn', 'approve');
      const parts = token.split(':');
      parts[1] = 'delete'; // actionId changed but HMAC is still for 'approve'
      const result = verifySignedCustomId(parts.join(':'));
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_signature');
    });
  });

  describe('verifySignedCustomId – expired timestamps', () => {
    it('rejects a token whose timestamp is 6 minutes in the past', () => {
      const SIX_MINUTES_MS = 6 * 60 * 1000;
      const oldTimestamp = (Date.now() - SIX_MINUTES_MS).toString();

      // Build a valid HMAC for the old timestamp using the real signing key
      
      const signingKey = process.env.INTERNAL_SECRET!;
      const hmac = createHmac('sha256', signingKey)
        .update(`approve:${oldTimestamp}`)
        .digest('hex')
        .slice(0, 32);

      const token = `btn:approve:${oldTimestamp}:${hmac}`;
      const result = verifySignedCustomId(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('token_expired');
    });

    it('rejects a token whose timestamp is 1 second past the 5-minute TTL', () => {
      const TOKEN_TTL_MS = 300_000;
      const expiredTimestamp = (Date.now() - TOKEN_TTL_MS - 1000).toString();

      
      const signingKey = process.env.INTERNAL_SECRET!;
      const hmac = createHmac('sha256', signingKey)
        .update(`action:${expiredTimestamp}`)
        .digest('hex')
        .slice(0, 32);

      const token = `prefix:action:${expiredTimestamp}:${hmac}`;
      const result = verifySignedCustomId(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('token_expired');
    });

    it('rejects a token with a future timestamp (clock skew / replay guard)', () => {
      const futureTimestamp = (Date.now() + 60_000).toString();

      
      const signingKey = process.env.INTERNAL_SECRET!;
      const hmac = createHmac('sha256', signingKey)
        .update(`action:${futureTimestamp}`)
        .digest('hex')
        .slice(0, 32);

      const token = `prefix:action:${futureTimestamp}:${hmac}`;
      const result = verifySignedCustomId(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('token_expired');
    });
  });
});
