import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeAgent } from './executor.js';

const mockGenerateText = vi.fn();

vi.mock('../adapters/registry.js', () => ({
  getLLMProvider: () => ({
    generateText: mockGenerateText,
  }),
  getTicketTracker: () => ({
    createSuggestion: vi.fn(),
    createTicket: vi.fn(),
  }),
}));
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('./prompt-builder.js', () => ({
  buildAgentPrompt: vi.fn().mockResolvedValue('Mock Prompt'),
  writeGeminiContext: vi.fn().mockResolvedValue({ cleanup: vi.fn() }),
}));
vi.mock('../db/index.js', () => {
  const mockQuery = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    orderBy: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    // Make the mock itself thenable so it can be awaited if needed
    then: (resolve: any) => Promise.resolve([]).then(resolve),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(mockQuery),
      update: vi.fn().mockReturnValue(mockQuery),
    },
  };
});

describe('executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute agent via fast path', async () => {
    mockGenerateText.mockResolvedValue('<thought>Thinking...</thought>Hello from AI');

    try {
      const result = await executeAgent({
        orgId: 'org-1',
        agentId: 'nexus',
        channelId: 'chan-1',
        userId: 'user-1',
        userName: 'Alice',
        userMessage: 'Hi',
        needsCodeAccess: false,
      });

      expect(result).toBe('Hello from AI');
      expect(mockGenerateText).toHaveBeenCalled();
    } catch (err) {
      console.error('EXECUTOR TEST ERROR:', err);
      throw err;
    }
  });
});
