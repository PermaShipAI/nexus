import './tests/env.js';
import { describe, it, expect } from 'vitest';
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
