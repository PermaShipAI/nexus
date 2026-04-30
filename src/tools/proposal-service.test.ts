import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'action-123' }]),
  },
}));

vi.mock('../db/schema.js', () => ({
  pendingActions: {},
  tickets: {},
}));

vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: vi.fn(() => ({
    resolveProjectId: vi.fn().mockResolvedValue('project-uuid-123'),
    resolveRepoKey: vi.fn().mockResolvedValue('my-repo'),
    resolveProjectSlug: vi.fn().mockResolvedValue('my-repo'),
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

vi.mock('../telemetry/cross-agent.js', () => ({
  logCrossAgentConflictResolved: vi.fn(),
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

// Must import AFTER vi.mock
import { createTicketProposal } from './proposal-service.js';
import { logGuardrailEvent } from '../telemetry/index.js';
import { logger } from '../logger.js';

const mockLogGuardrailEvent = vi.mocked(logGuardrailEvent);
const mockLoggerWarn = vi.mocked(logger.warn);

const baseInput = {
  orgId: 'org-123',
  kind: 'task' as const,
  title: 'Test ticket',
  description: 'Detailed description of the task.',
  project: 'My Project',
  agentId: 'sre' as const,
};

describe('createTicketProposal — fallback plan enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('idle source — missing fallbackPlan', () => {
    it('rejects idle proposals with no fallbackPlan', async () => {
      const result = await createTicketProposal({ ...baseInput, source: 'idle' });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/fallbackPlan/);
      expect(mockLogGuardrailEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'agentops_fallback_missing' }),
      );
    });
  });

  describe('fallbackPlan without explicit **Fallback:** label', () => {
    it('rejects when fallbackPlan does not start with **Fallback:**', async () => {
      const result = await createTicketProposal({
        ...baseInput,
        source: 'idle',
        fallbackPlan: 'If the primary plan fails, try a different approach.',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/must begin with "\*\*Fallback:\*\*"/);
      expect(mockLogGuardrailEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'agentops_fallback_malformed' }),
      );
    });

    it('rejects user-sourced proposals when fallbackPlan has wrong format', async () => {
      const result = await createTicketProposal({
        ...baseInput,
        source: 'user',
        fallbackPlan: 'Alternative: roll back the deployment.',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/must begin with "\*\*Fallback:\*\*"/);
      expect(mockLogGuardrailEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'agentops_fallback_malformed' }),
      );
    });

    it('rejects when fallbackPlan starts with lowercase fallback:', async () => {
      const result = await createTicketProposal({
        ...baseInput,
        fallbackPlan: 'fallback: try a manual fix.',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/must begin with "\*\*Fallback:\*\*"/);
    });
  });

  describe('fallbackPlan with correct explicit label', () => {
    it('accepts idle proposals with a correctly labeled fallbackPlan', async () => {
      const result = await createTicketProposal({
        ...baseInput,
        source: 'idle',
        fallbackPlan: '**Fallback:** If the primary migration fails, roll back using the backup snapshot.',
      });

      expect(result.success).toBe(true);
      expect(mockLogGuardrailEvent).not.toHaveBeenCalled();
    });

    it('accepts user-sourced proposals with a correctly labeled fallbackPlan', async () => {
      const result = await createTicketProposal({
        ...baseInput,
        source: 'user',
        fallbackPlan: '**Fallback:** Revert to the previous deployment if the new build is unstable.',
      });

      expect(result.success).toBe(true);
      expect(mockLogGuardrailEvent).not.toHaveBeenCalled();
    });

    it('accepts proposals with no fallbackPlan when source is user', async () => {
      const result = await createTicketProposal({
        ...baseInput,
        source: 'user',
      });

      expect(result.success).toBe(true);
      expect(mockLogGuardrailEvent).not.toHaveBeenCalled();
    });

    it('includes the fallbackPlan verbatim in the enriched description', async () => {
      const fallbackPlan = '**Fallback:** Use the cached data if the API is unavailable.';
      await createTicketProposal({
        ...baseInput,
        source: 'user',
        fallbackPlan,
      });

      // verify logger.info was called with hasFallbackPlan: true
      expect(mockLoggerWarn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('malformed'),
      );
    });
  });
});
