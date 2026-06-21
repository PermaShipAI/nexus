import { vi } from 'vitest';

// Mock gemini client to prevent GoogleGenAI constructor from throwing without API key
vi.mock('../gemini/client.js', () => ({
  callGemini: vi.fn().mockResolvedValue(''),
}));

vi.mock('../adapters/registry.js', () => ({
  getLLMProvider: vi.fn(),
}));

vi.mock('../../config/feature_flags.json', () => ({
  default: { ENABLE_STRUCTURED_INTENT: true, ENABLE_ACCOUNT_LINKING: false },
}));

import { classifyIntent } from './classifier';
import { getLLMProvider } from '../adapters/registry.js';

// Set mock mode for all tests by default
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

  describe('live mode (INTENT_MOCK_MODE=false)', () => {
    beforeEach(() => {
      process.env.INTENT_MOCK_MODE = 'false';
    });

    afterEach(() => {
      process.env.INTENT_MOCK_MODE = 'true';
    });

    it('returns Unknown when LLM response fails Zod schema validation', async () => {
      vi.mocked(getLLMProvider).mockReturnValue({
        generateText: vi.fn().mockResolvedValue(JSON.stringify({ invalidField: 'bad data' })),
      } as never);

      const result = await classifyIntent('investigate the login bug');
      expect(result.kind).toBe('Unknown');
      expect(result.confidenceScore).toBe(0);
    });

    it('returns valid classified intent when LLM response matches schema', async () => {
      vi.mocked(getLLMProvider).mockReturnValue({
        generateText: vi.fn().mockResolvedValue(
          JSON.stringify({ kind: 'InvestigateBug', confidenceScore: 0.9, params: {} }),
        ),
      } as never);

      const result = await classifyIntent('investigate the login bug');
      expect(result.kind).toBe('InvestigateBug');
      expect(result.confidenceScore).toBe(0.9);
    });
  });
});
