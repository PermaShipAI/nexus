import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeAgent } from './executor.js';
import { logger } from '../logger.js';
import { createTicketProposal } from '../tools/proposal-service.js';

const mockGenerateText = vi.fn();
const mockGenerateWithTools = vi.fn();
// Mutable reference so individual tests can override the source explorer
let mockSourceExplorer: Record<string, unknown> | null = null;

vi.mock('../adapters/registry.js', () => ({
  getLLMProvider: () => ({
    generateText: mockGenerateText,
    generateWithTools: mockGenerateWithTools,
  }),
  getTicketTracker: () => ({
    createSuggestion: vi.fn(),
    createTicket: vi.fn(),
  }),
  getSourceExplorer: () => mockSourceExplorer,
  getWorkspaceProvider: () => null,
  getProjectRegistry: () => ({
    listProjects: vi.fn().mockResolvedValue([]),
    resolveProjectId: vi.fn().mockResolvedValue(undefined),
    resolveRepoKey: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../../agents/telemetry/logger.js', () => ({
  logToolStrippingEvent: vi.fn(),
}));
vi.mock('../tools/proposal-service.js', () => ({
  createTicketProposal: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../settings/service.js', () => ({
  isAutonomousMode: vi.fn().mockResolvedValue(false),
}));
vi.mock('../tools/update_project_settings.js', () => ({
  updateProjectSettings: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../missions/service.js', () => ({
  getMissionItem: vi.fn(),
  updateMissionItem: vi.fn().mockResolvedValue({}),
}));
vi.mock('../missions/scheduler.js', () => ({
  onMissionItemChanged: vi.fn(),
}));
vi.mock('../idle/throttle.js', () => ({
  shouldCreateSuggestion: vi.fn().mockResolvedValue(true),
}));
vi.mock('../bot/interactions.js', () => ({
  sendApprovalMessage: vi.fn().mockResolvedValue(undefined),
  sendAutonomousNotification: vi.fn().mockResolvedValue(undefined),
  sendPublicChannelAlerts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./registry.js', () => ({
  getAgent: vi.fn().mockReturnValue({ title: 'Test Agent', id: 'nexus' }),
}));
vi.mock('../utils/parse-args.js', () => ({
  parseArgs: vi.fn().mockReturnValue({}),
}));
vi.mock('./code-tools.js', () => ({
  CODE_TOOL_DECLARATIONS: [],
  executeCodeTool: vi.fn().mockResolvedValue('tool result'),
}));

describe('executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSourceExplorer = null;
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

  it('should skip malformed JSON in ticket-proposal block and return remaining text', async () => {
    // LLM returns a response with an invalid JSON ticket-proposal block
    mockGenerateText.mockResolvedValue(
      '<ticket-proposal>INVALID JSON {{{</ticket-proposal>Response after malformed proposal',
    );

    const result = await executeAgent({
      orgId: 'org-1',
      agentId: 'qa-manager',
      channelId: 'chan-1',
      userId: 'user-1',
      userName: 'Alice',
      userMessage: 'Create a ticket',
      needsCodeAccess: false,
    });

    // The executor should return the clean text after stripping the broken block
    expect(result).toBe('Response after malformed proposal');
    // The malformed proposal should have been skipped, not forwarded to the ticket service
    expect(vi.mocked(createTicketProposal)).not.toHaveBeenCalled();
    // A warning should have been logged
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'qa-manager' }),
      expect.stringContaining('ticket-proposal'),
    );
  });

  it('should return [error] when the LLM throws and source is user', async () => {
    // Simulate an API error such as a timeout or rate-limit rejection
    mockGenerateText.mockRejectedValue(new Error('Connection timeout after 30s'));

    const result = await executeAgent({
      orgId: 'org-1',
      agentId: 'nexus',
      channelId: 'chan-1',
      userId: 'user-1',
      userName: 'Alice',
      userMessage: 'Analyze this',
      needsCodeAccess: false,
      source: 'user',
    });

    // User-initiated requests should surface an error indicator, not silently return null
    expect(result).toBe('[error]');
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });

  it('should return null when the LLM throws and source is idle', async () => {
    mockGenerateText.mockRejectedValue(new Error('API quota exceeded'));

    const result = await executeAgent({
      orgId: 'org-1',
      agentId: 'sre',
      channelId: 'chan-1',
      userId: 'system',
      userName: 'System',
      userMessage: 'Review the system',
      needsCodeAccess: false,
      source: 'idle',
    });

    // Idle-initiated failures should return null (no user-facing error needed)
    expect(result).toBeNull();
  });

  it('should exhaust tool loop budget and force a final text response', async () => {
    // Temporarily remove DATABASE_URL so useEmbeddedDb=true forces executeFast,
    // while needsCodeAccess is left undefined (truthy for tool loop) and
    // the mock explorer is non-null, so hasCodeTools=true.
    const savedDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      mockSourceExplorer = { readFile: vi.fn(), listFiles: vi.fn() };

      // generateWithTools always returns a tool call — never an empty functionCalls array
      mockGenerateWithTools.mockResolvedValue({
        text: 'Searching...',
        functionCalls: [{ name: 'read_file', args: { path: 'src/index.ts' }, id: 'call_1' }],
        raw: null,
      });

      // generateText is called once after the budget is exhausted for the forced final answer
      mockGenerateText.mockResolvedValue('Final answer after tool budget exhausted');

      const result = await executeAgent({
        orgId: 'org-1',
        agentId: 'nexus',
        channelId: 'chan-1',
        userId: 'user-1',
        userName: 'Alice',
        userMessage: 'Analyze the codebase thoroughly',
        // needsCodeAccess is intentionally omitted (undefined → not false → hasCodeTools=true)
      });

      // The loop should run exactly MAX_TOOL_ROUNDS (6) times before giving up
      expect(mockGenerateWithTools).toHaveBeenCalledTimes(6);
      // After exhausting the budget, the executor must call generateText to get a final answer
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(result).toBe('Final answer after tool budget exhausted');
    } finally {
      process.env.DATABASE_URL = savedDatabaseUrl;
    }
  });
});
