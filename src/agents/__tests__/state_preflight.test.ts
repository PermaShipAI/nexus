import '../../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeAgent } from '../executor.js';
import { logger } from '../../logger.js';

const mockGenerateText = vi.fn();
const mockGenerateWithTools = vi.fn();

vi.mock('../../adapters/registry.js', () => ({
  getLLMProvider: () => ({
    generateText: mockGenerateText,
    generateWithTools: mockGenerateWithTools,
  }),
  getTicketTracker: () => ({
    createSuggestion: vi.fn(),
    createTicket: vi.fn(),
  }),
  getSourceExplorer: () => null,
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

vi.mock('../prompt-builder.js', () => ({
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
    then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
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
  resolveAutonomousMode: vi.fn().mockResolvedValue(false),
  isAutonomousMode: vi.fn().mockResolvedValue(false),
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

vi.mock('../registry.js', () => ({
  getAgent: vi.fn().mockReturnValue({ title: 'Test Agent', id: 'nexus' }),
}));

vi.mock('../../utils/parse-args.js', () => ({
  parseArgs: vi.fn().mockReturnValue({}),
}));

vi.mock('../code-tools.js', () => ({
  CODE_TOOL_DECLARATIONS: [],
  executeCodeTool: vi.fn().mockResolvedValue('tool result'),
}));

vi.mock('../adr-service.js', () => ({
  checkAndTriggerAdrDrafting: vi.fn().mockResolvedValue(undefined),
}));

// Helper: build a fake pendingAction record
function makePendingAction(status: string) {
  return {
    id: 'test-uuid',
    orgId: 'org-1',
    agentId: 'qa-manager',
    command: 'create-ticket',
    args: {},
    description: 'Test proposal',
    status,
    channelId: 'chan-1',
    suggestionId: null,
    discordMessageId: null,
    fileContext: null,
    source: null,
    projectId: null,
    lastStalenessCheckAt: null,
    stalenessCount: 0,
    createdAt: new Date(),
    resolvedAt: null,
    originalActionId: null,
  };
}

const BASE_INPUT = {
  orgId: 'org-1',
  agentId: 'nexus' as const,
  channelId: 'chan-1',
  userId: 'user-1',
  userName: 'Alice',
  needsCodeAccess: false as const,
};

describe('state_preflight: approve-proposal blocked when status is waiting_for_human', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Re-apply default db mock behaviour after clearAllMocks resets it
    const { db } = await import('../../db/index.js');
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      orderBy: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
    };
    vi.mocked(db.select).mockReturnValue(mockQuery as any);
    vi.mocked(db.update).mockReturnValue(mockQuery as any);
  });

  it('does NOT call db.update when action status is waiting_for_human', async () => {
    const { db } = await import('../../db/index.js');
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([makePendingAction('waiting_for_human')]),
      orderBy: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
    };
    vi.mocked(db.select).mockReturnValue(mockQuery as any);

    mockGenerateText.mockResolvedValue(
      '<approve-proposal>{"id":"test-uuid","reason":"automated"}</approve-proposal>',
    );

    await executeAgent({
      ...BASE_INPUT,
      userMessage: 'approve the proposal',
    });

    // db.update must NOT have been called (the preflight guard should have continued)
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('calls logger.warn with event: preflight_block when action status is waiting_for_human', async () => {
    const { db } = await import('../../db/index.js');
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([makePendingAction('waiting_for_human')]),
      orderBy: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
    };
    vi.mocked(db.select).mockReturnValue(mockQuery as any);

    mockGenerateText.mockResolvedValue(
      '<approve-proposal>{"id":"test-uuid","reason":"automated"}</approve-proposal>',
    );

    await executeAgent({
      ...BASE_INPUT,
      userMessage: 'approve the proposal',
    });

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'preflight_block' }),
      expect.stringContaining('approve-proposal blocked'),
    );
  });

  it('calls db.update with { status: "pending" } when action status is nexus_review (happy path)', async () => {
    const { db } = await import('../../db/index.js');

    // Capture the set() spy so we can assert on its arguments
    const mockSetSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const mockQueryWithNexusReview = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([makePendingAction('nexus_review')]),
      orderBy: vi.fn().mockReturnThis(),
      set: mockSetSpy,
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
    };
    vi.mocked(db.select).mockReturnValue(mockQueryWithNexusReview as any);
    vi.mocked(db.update).mockReturnValue({ set: mockSetSpy } as any);

    mockGenerateText.mockResolvedValue(
      '<approve-proposal>{"id":"test-uuid","reason":"automated"}</approve-proposal>',
    );

    await executeAgent({
      ...BASE_INPUT,
      userMessage: 'approve the proposal',
    });

    // db.update should have been called
    expect(vi.mocked(db.update)).toHaveBeenCalled();
    // The set() call should include status: 'pending'
    expect(mockSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
  });
});

describe('state_preflight: reject-proposal blocked when status is waiting_for_human', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Re-apply default db mock behaviour after clearAllMocks resets it
    const { db } = await import('../../db/index.js');
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      orderBy: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
    };
    vi.mocked(db.select).mockReturnValue(mockQuery as any);
    vi.mocked(db.update).mockReturnValue(mockQuery as any);
  });

  it('does NOT call db.update when action status is waiting_for_human', async () => {
    const { db } = await import('../../db/index.js');
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([makePendingAction('waiting_for_human')]),
      orderBy: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
    };
    vi.mocked(db.select).mockReturnValue(mockQuery as any);

    mockGenerateText.mockResolvedValue(
      '<reject-proposal>{"id":"test-uuid","reason":"automated"}</reject-proposal>',
    );

    await executeAgent({
      ...BASE_INPUT,
      userMessage: 'reject the proposal',
    });

    // db.update must NOT have been called (the preflight guard should have continued)
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('calls logger.warn with event: preflight_block when action status is waiting_for_human', async () => {
    const { db } = await import('../../db/index.js');
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([makePendingAction('waiting_for_human')]),
      orderBy: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
    };
    vi.mocked(db.select).mockReturnValue(mockQuery as any);

    mockGenerateText.mockResolvedValue(
      '<reject-proposal>{"id":"test-uuid","reason":"automated"}</reject-proposal>',
    );

    await executeAgent({
      ...BASE_INPUT,
      userMessage: 'reject the proposal',
    });

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'preflight_block' }),
      expect.stringContaining('reject-proposal blocked'),
    );
  });

  it('calls db.update with { status: "rejected" } when action status is nexus_review (happy path)', async () => {
    const { db } = await import('../../db/index.js');

    // Capture the set() spy so we can assert on its arguments
    const mockSetSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const mockQueryWithNexusReview = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([makePendingAction('nexus_review')]),
      orderBy: vi.fn().mockReturnThis(),
      set: mockSetSpy,
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
    };
    vi.mocked(db.select).mockReturnValue(mockQueryWithNexusReview as any);
    vi.mocked(db.update).mockReturnValue({ set: mockSetSpy } as any);

    mockGenerateText.mockResolvedValue(
      '<reject-proposal>{"id":"test-uuid","reason":"automated"}</reject-proposal>',
    );

    await executeAgent({
      ...BASE_INPUT,
      userMessage: 'reject the proposal',
    });

    // db.update should have been called
    expect(vi.mocked(db.update)).toHaveBeenCalled();
    // The set() call should include status: 'rejected'
    expect(mockSetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected' }),
    );
  });
});
