import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: vi.fn(),
  getCommitProvider: vi.fn(),
  getLLMProvider: vi.fn(),
}));

vi.mock('../telemetry/index.js', () => ({
  logGuardrailEvent: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Stub out modules that are not under test
vi.mock('../nexus/scheduler.js', () => ({
  onProposalCreated: vi.fn(),
}));

vi.mock('../telemetry/cross-agent.js', () => ({
  logCrossAgentConflictResolved: vi.fn(),
}));

// Must import AFTER vi.mock
import { detectApprovalGates, createTicketProposal } from './proposal-service.js';
import { db } from '../db/index.js';
import { getProjectRegistry, getCommitProvider, getLLMProvider } from '../adapters/registry.js';
import { logGuardrailEvent } from '../telemetry/index.js';

const mockDb = vi.mocked(db);
const mockGetProjectRegistry = vi.mocked(getProjectRegistry);
const mockGetCommitProvider = vi.mocked(getCommitProvider);
const mockGetLLMProvider = vi.mocked(getLLMProvider);
const mockLogGuardrailEvent = vi.mocked(logGuardrailEvent);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a chainable mock for db.select(...).from(...).where(...).orderBy(...).limit(...) */
function makeSelectMock(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

/** Build a chainable mock for db.insert(...).values(...).returning() */
function makeInsertMock(returnedRow: Record<string, unknown>) {
  const chain = {
    values: vi.fn(),
    returning: vi.fn().mockResolvedValue([returnedRow]),
  };
  chain.values.mockReturnValue(chain);
  return chain;
}

/** Default project registry mock — resolves everything successfully. */
function defaultProjectRegistry() {
  return {
    resolveProjectId: vi.fn().mockResolvedValue('proj-uuid-001'),
    listProjects: vi.fn().mockResolvedValue([]),
    resolveRepoKey: vi.fn().mockResolvedValue('my-repo'),
    resolveProjectSlug: vi.fn().mockResolvedValue('my-repo'),
  };
}

const baseInput = {
  orgId: 'org-abc',
  kind: 'task' as const,
  title: 'My Ticket',
  description: 'Some work to do.',
  project: 'my-project',
  agentId: 'sre' as const,
  source: 'idle' as const,
  fallbackPlan: '**Fallback:** manual steps',
};

// ---------------------------------------------------------------------------
// detectApprovalGates — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe('detectApprovalGates', () => {
  it('detects "Nexus DoD" from a plain sentence', () => {
    expect(detectApprovalGates('Nexus DoD review required')).toEqual(['Nexus DoD']);
  });

  it('detects multiple gates: CISO and QA Manager', () => {
    const result = detectApprovalGates('needs CISO and QA Manager sign-off');
    expect(result).toContain('CISO');
    expect(result).toContain('QA Manager');
    expect(result).toHaveLength(2);
  });

  it('is case-insensitive — "nexus dod" matches canonical "Nexus DoD"', () => {
    expect(detectApprovalGates('nexus dod')).toEqual(['Nexus DoD']);
  });

  it('returns [] when no known keywords are present', () => {
    expect(detectApprovalGates('no special review needed')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createTicketProposal — integration with mocked dependencies
// ---------------------------------------------------------------------------

describe('createTicketProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no duplicate tickets found (empty select results)
    mockDb.select.mockReturnValue(makeSelectMock([]) as unknown as ReturnType<typeof db.select>);

    // Default: successful insert returning a row with an id
    mockDb.insert.mockReturnValue(
      makeInsertMock({ id: 'action-id-123' }) as unknown as ReturnType<typeof db.insert>,
    );

    // Default project registry
    mockGetProjectRegistry.mockReturnValue(defaultProjectRegistry() as unknown as ReturnType<typeof getProjectRegistry>);

    // Default commit provider
    mockGetCommitProvider.mockReturnValue({
      fetchLatestCommit: vi.fn().mockResolvedValue({ sha: 'abc123' }),
    } as unknown as ReturnType<typeof getCommitProvider>);

    // Default LLM provider (used for duplicate check when source !== 'idle')
    mockGetLLMProvider.mockReturnValue({
      generateText: vi.fn().mockResolvedValue('NOVEL'),
    } as unknown as ReturnType<typeof getLLMProvider>);
  });

  describe('approval_gates stored from auto-detection', () => {
    it('stores approval_gates: ["Nexus DoD"] when description contains "Nexus DoD"', async () => {
      const result = await createTicketProposal({
        ...baseInput,
        description: 'This task requires Nexus DoD review before merging.',
      });

      expect(result.success).toBe(true);

      const insertCall = mockDb.insert.mock.calls[0];
      expect(insertCall).toBeDefined();

      // Retrieve the .values() call on the returned chain
      const insertChain = mockDb.insert.mock.results[0].value as { values: ReturnType<typeof vi.fn> };
      const insertedRow = insertChain.values.mock.calls[0][0] as Record<string, unknown>;

      expect((insertedRow.args as Record<string, unknown>).approval_gates).toEqual(['Nexus DoD']);
    });

    it('does NOT store approval_gates when description has no review keywords', async () => {
      const result = await createTicketProposal({
        ...baseInput,
        description: 'Routine cleanup of temporary files.',
      });

      expect(result.success).toBe(true);

      const insertChain = mockDb.insert.mock.results[0].value as { values: ReturnType<typeof vi.fn> };
      const insertedRow = insertChain.values.mock.calls[0][0] as Record<string, unknown>;

      expect((insertedRow.args as Record<string, unknown>)).not.toHaveProperty('approval_gates');
    });
  });

  describe('explicit approvalGates bypass auto-detection', () => {
    it('stores approval_gates: ["SRE"] when approvalGates is explicitly ["SRE"]', async () => {
      const result = await createTicketProposal({
        ...baseInput,
        description: 'No keywords here that would trigger detection.',
        approvalGates: ['SRE'],
      });

      expect(result.success).toBe(true);

      const insertChain = mockDb.insert.mock.results[0].value as { values: ReturnType<typeof vi.fn> };
      const insertedRow = insertChain.values.mock.calls[0][0] as Record<string, unknown>;

      expect((insertedRow.args as Record<string, unknown>).approval_gates).toEqual(['SRE']);
    });
  });

  describe('logGuardrailEvent is called when gates are non-empty', () => {
    it('calls logGuardrailEvent with event "ticket_creation_with_approval_gates" when gates detected', async () => {
      await createTicketProposal({
        ...baseInput,
        description: 'This requires CISO sign-off before proceeding.',
      });

      expect(mockLogGuardrailEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'ticket_creation_with_approval_gates',
        }),
      );
    });

    it('does NOT call logGuardrailEvent for approval_gates when no gates detected', async () => {
      await createTicketProposal({
        ...baseInput,
        description: 'Ordinary task, no sign-off required.',
      });

      const guardrailCalls = mockLogGuardrailEvent.mock.calls.filter(
        ([arg]) =>
          typeof arg === 'object' &&
          arg !== null &&
          (arg as Record<string, unknown>).event === 'ticket_creation_with_approval_gates',
      );

      expect(guardrailCalls).toHaveLength(0);
    });
  });
});
