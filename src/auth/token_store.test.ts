import { generateLinkToken, consumeLinkToken } from './token_store';

describe('token_store', () => {
  it('generates a raw token that can be consumed once', () => {
    const rawToken = generateLinkToken('user-abc');
    const result = consumeLinkToken(rawToken);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-abc');
  });

  it('rejects a token that has already been consumed (one-time-use)', () => {
    const rawToken = generateLinkToken('user-xyz');
    consumeLinkToken(rawToken); // First use
    const result = consumeLinkToken(rawToken); // Second use
    expect(result).toBeNull();
  });

  it('rejects an invalid token', () => {
    const result = consumeLinkToken('nonexistent-token-12345');
    expect(result).toBeNull();
  });
});
