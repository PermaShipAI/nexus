import { vi } from 'vitest';

// Mock gemini client to prevent GoogleGenAI constructor from throwing without API key
vi.mock('../gemini/client.js', () => ({
  callGemini: vi.fn().mockResolvedValue(''),
}));

import { classifyIntent } from './classifier';

// Set mock mode for all tests
process.env.INTENT_MOCK_MODE = 'true';

describe('classifyIntent', () => {
  it('returns a known mock intent for a recognized message', async () => {
    const result = await classifyIntent('investigate the login bug');
    expect(result.kind).toBe('InvestigateBug');
    expect(result.confidenceScore).toBeGreaterThanOrEqual(0.6);
  });

  it('returns Unknown for unrecognized messages in mock mode', async () => {
    const result = await classifyIntent('asdfghjkl unrecognized message');
    expect(result.kind).toBe('Unknown');
    expect(result.confidenceScore).toBeLessThan(0.6);
  });

  it('returns SystemStatus for system status query', async () => {
    const result = await classifyIntent('what is the status of the system');
    expect(result.kind).toBe('SystemStatus');
    expect(result.confidenceScore).toBeGreaterThan(0.6);
  });

  it('returns AccessSecrets intent for secret retrieval', async () => {
    const result = await classifyIntent('get the database password');
    expect(result.kind).toBe('AccessSecrets');
  });
});
