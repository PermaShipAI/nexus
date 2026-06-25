import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB and schema before imports
vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  pendingActions: {},
  tickets: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  ne: vi.fn(),
  gte: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: vi.fn(),
  getCommitProvider: vi.fn(),
  getLLMProvider: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../nexus/scheduler.js', () => ({
  onProposalCreated: vi.fn(),
}));

vi.mock('../telemetry/cross-agent.js', () => ({
  logCrossAgentConflictResolved: vi.fn(),
}));

vi.mock('../telemetry/index.js', () => ({
  logGuardrailEvent: vi.fn(),
}));

vi.mock('../utils/parse-args.js', () => ({
  parseArgs: vi.fn((args: unknown) => args),
}));

// Must import AFTER vi.mock
import { createTicketProposal } from './proposal-service.js';
import { db } from '../db/index.js';
import { getProjectRegistry, getCommitProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';

const mockDb = vi.mocked(db);
const mockGetProjectRegistry = vi.mocked(getProjectRegistry);
const mockGetCommitProvider = vi.mocked(getCommitProvider);
const mockLoggerInfo = vi.mocked(logger.info);

const ORG_ID = 'org-test-123';
const PROJECT_ID = 'proj-uuid-456';
const REPO_KEY = 'my-repo';

function setupProjectRegistry() {
  mockGetProjectRegistry.mockReturnValue({
    resolveProjectId: vi.fn().mockResolvedValue(PROJECT_ID),
    resolveRepoKey: vi.fn().mockResolvedValue(REPO_KEY),
    resolveProjectSlug: vi.fn().mockResolvedValue('my-repo'),
    listProjects: vi.fn().mockResolvedValue([]),
  } as any);
}

function setupCommitProvider() {
  mockGetCommitProvider.mockReturnValue({
    fetchLatestCommit: vi.fn().mockResolvedValue({ sha: 'abc123' }),
  } as any);
}

function setupDbSelectEmpty() {
  // checkDuplicateTicket queries: pendingActions + tickets twice
  const emptyQuery = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
  mockDb.select = vi.fn().mockReturnValue(emptyQuery);
}

const baseInput = {
  orgId: ORG_ID,
  kind: 'bug' as const,
  title: 'Test ticket',
  description: 'A test description',
  project: 'MyProject',
  agentId: 'sre' as const,
  source: 'user' as const,
};

describe('createTicketProposal — requiresHumanApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupProjectRegistry();
    setupCommitProvider();
    setupDbSelectEmpty();
  });

  it('stores requiresHumanApproval: true in pendingActions.args when passed as true', async () => {
    let capturedArgs: Record<string, unknown> | undefined;

    const returningMock = vi.fn().mockResolvedValue([{ id: 'action-001' }]);
    const valuesMock = vi.fn().mockImplementation((row: { args: Record<string, unknown> }) => {
      capturedArgs = row.args;
      return { returning: returningMock };
    });
    mockDb.insert = vi.fn().mockReturnValue({ values: valuesMock });

    const result = await createTicketProposal({
      ...baseInput,
      requiresHumanApproval: true,
    });

    expect(result.success).toBe(true);
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.requiresHumanApproval).toBe(true);
  });

  it('stores requiresHumanApproval: false in pendingActions.args when omitted', async () => {
    let capturedArgs: Record<string, unknown> | undefined;

    const returningMock = vi.fn().mockResolvedValue([{ id: 'action-002' }]);
    const valuesMock = vi.fn().mockImplementation((row: { args: Record<string, unknown> }) => {
      capturedArgs = row.args;
      return { returning: returningMock };
    });
    mockDb.insert = vi.fn().mockReturnValue({ values: valuesMock });

    const result = await createTicketProposal({
      ...baseInput,
      // requiresHumanApproval intentionally omitted
    });

    expect(result.success).toBe(true);
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.requiresHumanApproval).toBe(false);
  });

  it('stores requiresHumanApproval: false in pendingActions.args when explicitly set to false', async () => {
    let capturedArgs: Record<string, unknown> | undefined;

    const returningMock = vi.fn().mockResolvedValue([{ id: 'action-003' }]);
    const valuesMock = vi.fn().mockImplementation((row: { args: Record<string, unknown> }) => {
      capturedArgs = row.args;
      return { returning: returningMock };
    });
    mockDb.insert = vi.fn().mockReturnValue({ values: valuesMock });

    const result = await createTicketProposal({
      ...baseInput,
      requiresHumanApproval: false,
    });

    expect(result.success).toBe(true);
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.requiresHumanApproval).toBe(false);
  });

  it('includes requiresHumanApproval in ticket_proposal.enriched log', async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'action-004' }]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert = vi.fn().mockReturnValue({ values: valuesMock });

    await createTicketProposal({
      ...baseInput,
      requiresHumanApproval: true,
    });

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresHumanApproval: true,
      }),
      'ticket_proposal.enriched',
    );
  });

  it('logs requiresHumanApproval: false when omitted', async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'action-005' }]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert = vi.fn().mockReturnValue({ values: valuesMock });

    await createTicketProposal({
      ...baseInput,
      // requiresHumanApproval omitted
    });

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresHumanApproval: false,
      }),
      'ticket_proposal.enriched',
    );
  });
});
