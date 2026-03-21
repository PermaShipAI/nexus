import './tests/env.js';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { encrypt, decrypt } from './crypto.js';

describe('crypto', () => {
  it('should encrypt and decrypt a string', () => {
    const text = 'Hello, PermaShip!';
    const encrypted = encrypt(text);
    expect(encrypted).not.toBe(text);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(text);
  });

  it('should produce different ciphertexts for the same plaintext', () => {
    const text = 'Repeatable test string';
    const encrypted1 = encrypt(text);
    const encrypted2 = encrypt(text);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('should fail to decrypt invalid data', () => {
    expect(() => decrypt('invalid-base64')).toThrow();
  });
});

describe('crypto property-based tests', () => {
  it('decrypt(encrypt(x)) === x for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (plaintext) => {
        const encrypted = encrypt(plaintext);
        const decrypted = decrypt(encrypted);
        return decrypted === plaintext;
      }),
      { numRuns: 200 },
    );
  });

  it('encrypt always produces different output for same input (random IV)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (plaintext) => {
        const a = encrypt(plaintext);
        const b = encrypt(plaintext);
        return a !== b;
      }),
      { numRuns: 100 },
    );
  });

  it('encrypted output is always valid base64', () => {
    fc.assert(
      fc.property(fc.string(), (plaintext) => {
        const encrypted = encrypt(plaintext);
        const decoded = Buffer.from(encrypted, 'base64').toString('base64');
        return decoded === encrypted;
      }),
      { numRuns: 100 },
    );
  });
});
