import '../env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @google/generative-ai — GoogleGenerativeAI must be a real constructor.
// We capture the inner mock via a module-level vi.fn() that is referenced by
// the factory.  Vitest hoists vi.mock() calls but the variable assignment
// `const mockGenerateContent = vi.fn()` is also moved to the top of the file
// by the transform, so it IS in scope when the factory runs.
// ---------------------------------------------------------------------------
const mockGenerateContent = vi.fn();

vi.mock('@google/generative-ai', () => {
  // Use a regular function so `new GoogleGenerativeAI(...)` works
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function GoogleGenerativeAI(_apiKey: string) {
    // `this` context isn't needed since we return an object
  }
  GoogleGenerativeAI.prototype.getGenerativeModel = function () {
    return {
      generateContent: mockGenerateContent,
      embedContent: vi.fn(),
    };
  };
  return { GoogleGenerativeAI };
});

// ---------------------------------------------------------------------------
// Mock the retry module — pass through withRetry so safety blocks propagate
// without triggering the real delay logic
// ---------------------------------------------------------------------------
vi.mock('../../adapters/providers/retry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../adapters/providers/retry.js')>();
  return {
    ...real,
    withRetry: async <T>(fn: () => Promise<T>) => fn(),
  };
});

// ---------------------------------------------------------------------------
// Mocks required by executor.ts (mirror executor.test.ts)
// ---------------------------------------------------------------------------
const mockGenerateText = vi.fn();
const mockGenerateWithTools = vi.fn();
let mockSourceExplorer: Record<string, unknown> | null = null;

vi.mock('../../adapters/registry.js', () => ({
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

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../agents/prompt-builder.js', () => ({
  buildAgentPrompt: vi.fn().mockResolvedValue('Mock Prompt'),
  writeGeminiContext: vi.fn().mockResolvedValue({ cleanup: vi.fn() }),
}));

vi.mock('../../db/index.js', () => {
  const mockQuery = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    orderBy: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(mockQuery),
      update: vi.fn().mockReturnValue(mockQuery),
    },
  };
});

vi.mock('../../../agents/telemetry/logger.js', () => ({
  logToolStrippingEvent: vi.fn(),
}));

vi.mock('../../tools/proposal-service.js', () => ({
  createTicketProposal: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../settings/service.js', () => ({
  isAutonomousMode: vi.fn().mockResolvedValue(false),
  resolveAutonomousMode: vi.fn().mockResolvedValue(false),
  getModelId: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../tools/update_project_settings.js', () => ({
  updateProjectSettings: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../missions/service.js', () => ({
  getMissionItem: vi.fn(),
  updateMissionItem: vi.fn().mockResolvedValue({}),
  addMissionItems: vi.fn().mockResolvedValue({}),
  addSubSteps: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../missions/scheduler.js', () => ({
  onMissionItemChanged: vi.fn(),
}));

vi.mock('../../idle/throttle.js', () => ({
  shouldCreateSuggestion: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../bot/interactions.js', () => ({
  sendApprovalMessage: vi.fn().mockResolvedValue(undefined),
  sendAutonomousNotification: vi.fn().mockResolvedValue(undefined),
  sendPublicChannelAlerts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../agents/registry.js', () => ({
  getAgent: vi.fn().mockReturnValue({ title: 'Test Agent', id: 'nexus' }),
}));

vi.mock('../../utils/parse-args.js', () => ({
  parseArgs: vi.fn().mockReturnValue({}),
}));

vi.mock('../../agents/code-tools.js', () => ({
  CODE_TOOL_DECLARATIONS: [],
  executeCodeTool: vi.fn().mockResolvedValue('tool result'),
}));

// ---------------------------------------------------------------------------
// Imports under test (must come after vi.mock declarations)
// ---------------------------------------------------------------------------
import { GeminiSafetyBlockError, DefaultLLMProvider } from '../../adapters/default/llm-provider.js';
import { isRetriable } from '../../adapters/providers/retry.js';
import { executeAgent } from '../../agents/executor.js';

// Shared SAFETY response payload (matches the spec)
const SAFETY_RESPONSE = {
  candidates: [
    {
      content: undefined,
      finishReason: 'SAFETY',
      safetyRatings: [
        { category: 'HARM_CATEGORY_HARASSMENT', probability: 'HIGH', blocked: true },
      ],
      index: 0,
    },
  ],
};

const BASE_INPUT = {
  orgId: 'org-1',
  agentId: 'nexus' as const,
  channelId: 'chan-1',
  userId: 'user-1',
  userName: 'Alice',
  userMessage: 'test message',
  needsCodeAccess: false as const,
};

describe('Gemini safety block handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSourceExplorer = null;
  });

  // -------------------------------------------------------------------------
  // Test 1: DefaultLLMProvider.generateText() throws GeminiSafetyBlockError
  // -------------------------------------------------------------------------
  it('DefaultLLMProvider.generateText() throws GeminiSafetyBlockError on SAFETY finish reason', async () => {
    mockGenerateContent.mockResolvedValue({ response: SAFETY_RESPONSE });

    const provider = new DefaultLLMProvider('test-key');

    await expect(
      provider.generateText({
        model: 'AGENT',
        systemInstruction: 'You are a helpful assistant',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }),
    ).rejects.toThrow(GeminiSafetyBlockError);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 2: DefaultLLMProvider.generateWithTools() throws GeminiSafetyBlockError
  // -------------------------------------------------------------------------
  it('DefaultLLMProvider.generateWithTools() throws GeminiSafetyBlockError on SAFETY finish reason', async () => {
    mockGenerateContent.mockResolvedValue({ response: SAFETY_RESPONSE });

    const provider = new DefaultLLMProvider('test-key');

    await expect(
      provider.generateWithTools({
        model: 'AGENT',
        systemInstruction: 'You are a helpful assistant',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        tools: [],
      }),
    ).rejects.toThrow(GeminiSafetyBlockError);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: isRetriable(new GeminiSafetyBlockError()) returns false
  // -------------------------------------------------------------------------
  it('isRetriable() returns false for GeminiSafetyBlockError', () => {
    expect(isRetriable(new GeminiSafetyBlockError())).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4: executeAgent() with source: 'user', needsCodeAccess: false
  //         returns the safety message string
  // -------------------------------------------------------------------------
  it('executeAgent() returns safety message for source=user when LLM throws GeminiSafetyBlockError', async () => {
    mockGenerateText.mockRejectedValue(new GeminiSafetyBlockError());

    const result = await executeAgent({
      ...BASE_INPUT,
      source: 'user',
      needsCodeAccess: false,
    });

    expect(result).toBe("I'm unable to respond to that request due to safety guidelines.");
  });

  // -------------------------------------------------------------------------
  // Test 5: executeAgent() with source: 'idle', needsCodeAccess: false
  //         returns null
  // -------------------------------------------------------------------------
  it('executeAgent() returns null for source=idle when LLM throws GeminiSafetyBlockError', async () => {
    mockGenerateText.mockRejectedValue(new GeminiSafetyBlockError());

    const result = await executeAgent({
      ...BASE_INPUT,
      source: 'idle',
      needsCodeAccess: false,
    });

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 6: executeAgent() with source: 'user', needsCodeAccess: true
  //         safety block on round 1 of tool loop → returns safety message.
  //         DATABASE_URL must be removed so executor takes executeFast (not executeCli).
  // -------------------------------------------------------------------------
  it('executeAgent() returns safety message when tool loop throws GeminiSafetyBlockError on round 1', async () => {
    const savedDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      // Provide a non-null source explorer so hasCodeTools=true and the tool loop is entered
      mockSourceExplorer = { readFile: vi.fn(), listFiles: vi.fn() };

      // generateWithTools throws a safety block on the first round
      mockGenerateWithTools.mockRejectedValue(new GeminiSafetyBlockError());

      const result = await executeAgent({
        ...BASE_INPUT,
        source: 'user',
        needsCodeAccess: true,
      });

      expect(result).toBe("I'm unable to respond to that request due to safety guidelines.");
      expect(mockGenerateWithTools).toHaveBeenCalledTimes(1);
    } finally {
      process.env.DATABASE_URL = savedDatabaseUrl;
    }
  });
});
