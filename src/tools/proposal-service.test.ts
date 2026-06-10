import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../db/index.js', () => {
  const mockReturning = vi.fn().mockResolvedValue([
    {
      id: 'action-uuid-123',
      orgId: 'org-1',
      agentId: 'qa-manager',
      command: 'create-ticket',
      args: {},
      description: 'Create task ticket: "Test Ticket"',
      status: 'nexus_review',
      createdAt: new Date(),
    },
  ]);
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  // db.select() chain used by checkDuplicateTicket — returns empty arrays (no duplicates)
  const mockSelectQuery = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    then: (resolve: any) => Promise.resolve([]).then(resolve),
  };
  const mockSelect = vi.fn().mockReturnValue(mockSelectQuery);
  return {
    db: {
      insert: mockInsert,
      select: mockSelect,
    },
  };
});

vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: () => ({
    resolveProjectId: vi.fn().mockResolvedValue('project-uuid-1'),
    listProjects: vi.fn().mockResolvedValue([{ id: 'project-uuid-1', name: 'Test Project', slug: 'test-project' }]),
    resolveRepoKey: vi.fn().mockResolvedValue('test-repo'),
    resolveProjectSlug: vi.fn().mockResolvedValue('test-project'),
  }),
  getCommitProvider: () => ({
    fetchLatestCommit: vi.fn().mockResolvedValue({ sha: 'abc123' }),
  }),
  getLLMProvider: () => ({
    generateText: vi.fn().mockResolvedValue('NOVEL'),
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

vi.mock('../nexus/scheduler.js', () => ({
  onProposalCreated: vi.fn(),
}));

vi.mock('../telemetry/cross-agent.js', () => ({
  logCrossAgentConflictResolved: vi.fn(),
}));

vi.mock('../telemetry/index.js', () => ({
  logGuardrailEvent: vi.fn(),
}));

// Must import AFTER vi.mock calls
import { createTicketProposal } from './proposal-service.js';
import { db } from '../db/index.js';

describe('createTicketProposal — skipPush flag', () => {
  let capturedArgs: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedArgs = null;

    // Capture the args passed to db.insert so we can assert on them
    const mockReturning = vi.fn().mockResolvedValue([
      {
        id: 'action-uuid-123',
        orgId: 'org-1',
        agentId: 'qa-manager',
        command: 'create-ticket',
        args: {},
        description: 'Create task ticket: "Test Ticket"',
        status: 'nexus_review',
        createdAt: new Date(),
      },
    ]);
    const mockValues = vi.fn().mockImplementation((vals) => {
      capturedArgs = vals.args as Record<string, unknown>;
      return { returning: mockReturning };
    });
    // Re-mock db.insert to capture args on each test run
    (db as any).insert = vi.fn().mockReturnValue({ values: mockValues });

    // Also reset db.select to return empty arrays (no duplicates)
    const mockSelectQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      then: (resolve: any) => Promise.resolve([]).then(resolve),
    };
    (db as any).select = vi.fn().mockReturnValue(mockSelectQuery);
  });

  it('stores skipPush=false by default when not provided', async () => {
    const result = await createTicketProposal({
      orgId: 'org-1',
      kind: 'task',
      title: 'Refactor authentication module',
      description: 'Improve code quality in the auth module.',
      project: 'Test Project',
      agentId: 'qa-manager',
    });

    expect(result.success).toBe(true);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.skipPush).toBe(false);
  });

  it('stores skipPush=true when explicitly set by the LLM', async () => {
    const result = await createTicketProposal({
      orgId: 'org-1',
      kind: 'task',
      title: 'Security audit of payment flow',
      description: 'CISO review required before deployment.',
      project: 'Test Project',
      agentId: 'ciso',
      skipPush: true,
    });

    expect(result.success).toBe(true);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.skipPush).toBe(true);
  });

  it('forces skipPush=true when description contains "Nexus DoD" (safety net)', async () => {
    const result = await createTicketProposal({
      orgId: 'org-1',
      kind: 'feature',
      title: 'Implement new billing feature',
      description: 'This ticket requires a Nexus DoD review before code is merged.',
      project: 'Test Project',
      agentId: 'qa-manager',
      skipPush: false, // LLM set it to false — safety net must override
    });

    expect(result.success).toBe(true);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.skipPush).toBe(true);
  });

  it('forces skipPush=true when title contains "Nexus DoD" (safety net)', async () => {
    const result = await createTicketProposal({
      orgId: 'org-1',
      kind: 'task',
      title: 'AgentOps/Bug: Enforce skip_push Flag (Nexus DoD)',
      description: 'State machine conflict fix.',
      project: 'Test Project',
      agentId: 'sre',
      // skipPush not provided — defaults false, but title triggers safety net
    });

    expect(result.success).toBe(true);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.skipPush).toBe(true);
  });

  it('forces skipPush=true case-insensitively for "nexus dod" in description', async () => {
    const result = await createTicketProposal({
      orgId: 'org-1',
      kind: 'bug',
      title: 'Critical security patch',
      description: 'Per NEXUS DOD requirements, this must go through CISO sign-off.',
      project: 'Test Project',
      agentId: 'ciso',
      skipPush: false,
    });

    expect(result.success).toBe(true);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.skipPush).toBe(true);
  });

  it('stores skipPush=false for regular tickets without review gates', async () => {
    const result = await createTicketProposal({
      orgId: 'org-1',
      kind: 'bug',
      title: 'Fix broken login redirect',
      description: 'After logging in, users are redirected to a 404 page.',
      project: 'Test Project',
      agentId: 'sre',
      skipPush: false,
    });

    expect(result.success).toBe(true);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.skipPush).toBe(false);
  });
});
