import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — factory must not reference top-level variables.
// Use vi.fn() inline; grab typed refs after import.

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  pendingActions: {},
  tickets: {},
  ticketsTable: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ eq: val })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  gte: vi.fn((_col: unknown, val: unknown) => ({ gte: val })),
  ne: vi.fn((_col: unknown, val: unknown) => ({ ne: val })),
}));

vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: vi.fn(() => ({
    resolveProjectId: vi.fn().mockResolvedValue('proj-uuid'),
    resolveRepoKey: vi.fn().mockResolvedValue('repo-key'),
    resolveProjectSlug: vi.fn().mockResolvedValue(null),
    listProjects: vi.fn().mockResolvedValue([]),
  })),
  getCommitProvider: vi.fn(() => ({
    fetchLatestCommit: vi.fn().mockResolvedValue({ sha: 'abc123' }),
  })),
  getLLMProvider: vi.fn(() => ({
    generateText: vi.fn().mockResolvedValue('NOVEL'),
  })),
}));

vi.mock('../nexus/scheduler.js', () => ({
  onProposalCreated: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../telemetry/cross-agent.js', () => ({
  logCrossAgentConflictResolved: vi.fn(),
  logDodPreflightBlocked: vi.fn(),
}));

vi.mock('../telemetry/index.js', () => ({
  logGuardrailEvent: vi.fn(),
}));

vi.mock('../utils/parse-args.js', () => ({
  parseArgs: vi.fn((args: unknown) => (typeof args === 'object' && args !== null ? args : {})),
}));

// Import after vi.mock so hoisting resolves correctly
import { db } from '../db/index.js';
import { createTicketProposal, DOD_TRANSITION_BLOCKED_ERROR } from './proposal-service.js';
import { logDodPreflightBlocked } from '../telemetry/cross-agent.js';

const mockDb = vi.mocked(db);
const mockLogDodPreflightBlocked = vi.mocked(logDodPreflightBlocked);

// Build a chainable drizzle select mock that resolves to `rows`
function buildSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function buildInsertChain(returning: unknown[]) {
  return {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returning),
  };
}

const LONG_TITLE = 'Fix the authentication token storage vulnerability in session middleware';

const BASE_INPUT = {
  orgId: 'org-abc',
  kind: 'bug' as const,
  title: LONG_TITLE,
  description: 'Detailed description of the bug',
  project: 'nexus',
  agentId: 'ciso' as const,
};

describe('createTicketProposal — DoD pre-flight gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks creation when an existing waiting_for_human proposal title matches', async () => {
    // Gate query returns a matching waiting_for_human proposal
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([
        { id: 'proposal-wfh-123', args: { title: LONG_TITLE } },
      ]) as ReturnType<typeof db.select>)
      .mockReturnValue(buildSelectChain([]) as ReturnType<typeof db.select>);

    const result = await createTicketProposal(BASE_INPUT);

    expect(result.success).toBe(false);
    expect(result.message).toBe(DOD_TRANSITION_BLOCKED_ERROR);
  });

  it('emits logDodPreflightBlocked telemetry when blocked', async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([
        { id: 'proposal-wfh-123', args: { title: LONG_TITLE } },
      ]) as ReturnType<typeof db.select>)
      .mockReturnValue(buildSelectChain([]) as ReturnType<typeof db.select>);

    await createTicketProposal(BASE_INPUT);

    expect(mockLogDodPreflightBlocked).toHaveBeenCalledWith({
      orgId: 'org-abc',
      agentId: 'ciso',
      title: LONG_TITLE,
      blockedByProposalId: 'proposal-wfh-123',
    });
  });

  it('does not block when no waiting_for_human proposals exist', async () => {
    // All queries return empty: gate passes, duplicate check passes
    mockDb.select
      .mockReturnValue(buildSelectChain([]) as ReturnType<typeof db.select>);

    mockDb.insert.mockReturnValue(
      buildInsertChain([{ id: 'new-action-id', status: 'nexus_review' }]) as ReturnType<typeof db.insert>,
    );

    const result = await createTicketProposal(BASE_INPUT);

    expect(result.success).toBe(true);
    expect(mockLogDodPreflightBlocked).not.toHaveBeenCalled();
  });

  it('does not block when the waiting_for_human title is too short for prefix matching', async () => {
    // Existing waiting_for_human title is shorter than MIN_PREFIX (30 chars) — gate skips it
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([
        { id: 'proposal-wfh-456', args: { title: 'Short title' } },
      ]) as ReturnType<typeof db.select>)
      .mockReturnValue(buildSelectChain([]) as ReturnType<typeof db.select>);

    mockDb.insert.mockReturnValue(
      buildInsertChain([{ id: 'new-action-id-2', status: 'nexus_review' }]) as ReturnType<typeof db.insert>,
    );

    const result = await createTicketProposal(BASE_INPUT);

    expect(result.success).toBe(true);
    expect(mockLogDodPreflightBlocked).not.toHaveBeenCalled();
  });

  it('DOD_TRANSITION_BLOCKED_ERROR contains the required directive microcopy', () => {
    expect(DOD_TRANSITION_BLOCKED_ERROR).toContain('ERROR_TRANSITION_BLOCKED');
    expect(DOD_TRANSITION_BLOCKED_ERROR).toContain('waiting_for_human');
    expect(DOD_TRANSITION_BLOCKED_ERROR).toContain('Do not retry');
  });
});
