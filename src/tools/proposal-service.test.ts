import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'action-1' }]),
      }),
    }),
  },
}));

vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: vi.fn().mockReturnValue({
    resolveProjectId: vi.fn().mockResolvedValue('proj-uuid'),
    resolveRepoKey: vi.fn().mockResolvedValue(null),
    resolveProjectSlug: vi.fn().mockResolvedValue('my-project'),
    listProjects: vi.fn().mockResolvedValue([]),
  }),
  getCommitProvider: vi.fn().mockReturnValue({
    fetchLatestCommit: vi.fn().mockResolvedValue(null),
  }),
  getLLMProvider: vi.fn().mockReturnValue({
    generateText: vi.fn().mockResolvedValue('NOVEL'),
  }),
}));

vi.mock('../nexus/scheduler.js', () => ({
  onProposalCreated: vi.fn(),
}));

vi.mock('../telemetry/index.js', () => ({
  logGuardrailEvent: vi.fn(),
}));

vi.mock('../telemetry/cross-agent.js', () => ({
  logCrossAgentConflictResolved: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import after mocks
import { createTicketProposal } from './proposal-service.js';
import { logGuardrailEvent } from '../telemetry/index.js';

const mockLogGuardrailEvent = vi.mocked(logGuardrailEvent);

const validInput = {
  orgId: 'org-1',
  kind: 'task' as const,
  title: 'Test ticket',
  description: 'Some description',
  project: 'my-project',
  agentId: 'nexus' as const,
  agentDiscussionContext: 'We discussed the approach and agreed on X.',
  fallbackPlan: '**Fallback:** If primary fails, revert to Y.',
};

describe('createTicketProposal — Zod validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns validation failure when agentDiscussionContext is missing', async () => {
    const input = { ...validInput, agentDiscussionContext: '' };
    const result = await createTicketProposal(input);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Validation Failed/);
    expect(result.message).toMatch(/agentDiscussionContext/);
  });

  it('returns validation failure when fallbackPlan is missing', async () => {
    // @ts-expect-error — testing runtime rejection of missing required field
    const input = { ...validInput, fallbackPlan: undefined };
    const result = await createTicketProposal(input);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Validation Failed/);
    expect(result.message).toMatch(/fallbackPlan/);
  });

  it('returns validation failure when fallbackPlan lacks the required prefix', async () => {
    const input = { ...validInput, fallbackPlan: 'Some plan without prefix' };
    const result = await createTicketProposal(input);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Validation Failed/);
    expect(result.message).toMatch(/\*\*Fallback:\*\*/);
  });

  it('emits ticket_proposal_validation_failed guardrail event on rejection', async () => {
    const input = { ...validInput, fallbackPlan: 'bad plan' };
    await createTicketProposal(input);
    expect(mockLogGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ticket_proposal_validation_failed' }),
    );
  });

  it('succeeds when agentDiscussionContext and fallbackPlan are valid', async () => {
    const result = await createTicketProposal(validInput);
    expect(result.success).toBe(true);
    expect(mockLogGuardrailEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ticket_proposal_validation_failed' }),
    );
  });
});
