import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies before importing the module under test
vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'action-123' }]),
      }),
    }),
  },
}));

vi.mock('../db/schema.js', () => ({
  pendingActions: {},
  tickets: {},
}));

vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: vi.fn().mockReturnValue({
    resolveProjectId: vi.fn().mockResolvedValue('project-uuid-123'),
    listProjects: vi.fn().mockResolvedValue([{ name: 'MyProject' }]),
    resolveRepoKey: vi.fn().mockResolvedValue('my-repo'),
    resolveProjectSlug: vi.fn().mockResolvedValue('my-repo'),
  }),
  getCommitProvider: vi.fn().mockReturnValue({
    fetchLatestCommit: vi.fn().mockResolvedValue({ sha: 'abc123' }),
  }),
  getLLMProvider: vi.fn().mockReturnValue({
    generateText: vi.fn().mockResolvedValue('NOVEL'),
  }),
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

vi.mock('../utils/parse-args.js', () => ({
  parseArgs: vi.fn().mockReturnValue({}),
}));

// Import after mocks
import { detectTranscriptPatterns, scoreProposalConfidence, createTicketProposal } from './proposal-service.js';
import { logGuardrailEvent } from '../telemetry/index.js';
import { logger } from '../logger.js';

const mockLogGuardrailEvent = vi.mocked(logGuardrailEvent);
const mockLoggerWarn = vi.mocked(logger.warn);
const mockLoggerInfo = vi.mocked(logger.info);

const baseInput = {
  orgId: 'org-abc',
  kind: 'task' as const,
  title: 'Fix auth token validation in src/auth/token.ts',
  description: 'The token validation logic has a bypass vulnerability. Patch the parameterised query enforcement in `src/auth/token.ts` to close CVE-2024-9999.',
  project: 'MyProject',
  agentId: 'nexus' as const,
  source: 'idle' as const,
  fallbackPlan: '**Fallback:** If automated patch fails, flag for manual review and disable the endpoint.',
};

describe('detectTranscriptPatterns', () => {
  it('returns empty array for clean synthesized prose', () => {
    const prose = 'The authentication service has a token validation bypass. The team agreed to patch src/auth/token.ts by adding parameterised queries.';
    expect(detectTranscriptPatterns(prose)).toEqual([]);
  });

  it('detects repeated [Agent]: prefix lines', () => {
    const transcript = [
      '[CISO]: We need to patch the token validator.',
      '[SRE]: Agreed, the bypass is critical.',
      '[QA]: I can write tests for it.',
      '',
    ].join('\n');
    const result = detectTranscriptPatterns(transcript);
    expect(result).toContain('repeated_agent_prefix_lines');
  });

  it('detects timestamp-prefixed chat lines', () => {
    const transcript = [
      '12:34 CISO: We need to patch the token validator.',
      '12:35 SRE: Agreed, the bypass is critical.',
      '12:36 QA: I can write tests for it.',
      '',
    ].join('\n');
    const result = detectTranscriptPatterns(transcript);
    expect(result).toContain('timestamp_chat_lines');
  });

  it('detects @mention prefix lines', () => {
    const transcript = [
      '@ciso-agent: We need to patch the token validator.',
      '@sre-agent: Agreed, the bypass is critical.',
      '@qa-agent: I can write tests for it.',
      '@nexus-agent: Approving the fix.',
      '',
    ].join('\n');
    const result = detectTranscriptPatterns(transcript);
    expect(result).toContain('mention_prefix_lines');
  });

  it('detects "said:" log lines', () => {
    const transcript = [
      'CISO said: We need to patch the token validator.',
      'SRE said: Agreed, the bypass is critical.',
      'QA said: I can write tests for it.',
      '',
    ].join('\n');
    const result = detectTranscriptPatterns(transcript);
    expect(result).toContain('said_log_lines');
  });

  it('does not flag a single agent prefix line (requires 2+ consecutive)', () => {
    const singleLine = '[CISO]: We need to patch the token validator.\nSome other content here.';
    const result = detectTranscriptPatterns(singleLine);
    expect(result).not.toContain('repeated_agent_prefix_lines');
  });
});

describe('scoreProposalConfidence', () => {
  it('returns 1.0 for a fully specified proposal', () => {
    const score = scoreProposalConfidence({
      title: 'Fix SQL injection in src/db/query-builder.ts',
      description: 'Add parameterised query enforcement to prevent SQL injection attacks in the query builder module. This addresses CVE-2024-1234.',
      agentDiscussionContext: 'CISO flagged the issue during security audit. The team agreed to add input sanitisation and parameterised queries to src/db/query-builder.ts. SRE confirmed no performance impact.',
      fallbackPlan: '**Fallback:** If parameterised queries break existing behavior, roll back and add WAF rules as interim protection.',
    });
    expect(score).toBe(1.0);
  });

  it('deducts 0.25 for missing agentDiscussionContext', () => {
    const score = scoreProposalConfidence({
      title: 'Fix SQL injection in src/db/query-builder.ts',
      description: 'Add parameterised query enforcement to prevent SQL injection. See CVE-2024-1234.',
      agentDiscussionContext: undefined,
      fallbackPlan: '**Fallback:** Roll back and add WAF rules.',
    });
    expect(score).toBe(0.75);
  });

  it('deducts 0.25 for very short description', () => {
    const score = scoreProposalConfidence({
      title: 'Fix bug in src/auth/token.ts',
      description: 'Fix the bug.',
      agentDiscussionContext: 'Team discussed the bug at length and agreed to fix it using parameterised queries in the token validator.',
      fallbackPlan: '**Fallback:** Manual patch.',
    });
    expect(score).toBe(0.75);
  });

  it('deducts 0.25 for missing fallbackPlan', () => {
    const score = scoreProposalConfidence({
      title: 'Fix SQL injection in src/db/query-builder.ts',
      description: 'Add parameterised query enforcement to prevent SQL injection attacks. See CVE-2024-1234.',
      agentDiscussionContext: 'Team agreed to add parameterised queries to the query builder after security audit identified SQL injection risk.',
      fallbackPlan: undefined,
    });
    expect(score).toBe(0.75);
  });

  it('returns 0 for a completely underspecified proposal', () => {
    const score = scoreProposalConfidence({
      title: 'Fix bug',
      description: 'Fix it',
      agentDiscussionContext: undefined,
      fallbackPlan: undefined,
    });
    expect(score).toBe(0);
  });

  it('score does not go below 0', () => {
    const score = scoreProposalConfidence({
      title: 'do stuff',
      description: 'do stuff',
      agentDiscussionContext: 'short',
      fallbackPlan: undefined,
    });
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe('createTicketProposal — transcript rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects proposals with raw transcript in agentDiscussionContext', async () => {
    const transcriptContext = [
      '[CISO]: We need to patch the token validator.',
      '[SRE]: Agreed, the bypass is critical.',
      '[QA]: I can write tests for it.',
      '',
    ].join('\n');

    const result = await createTicketProposal({
      ...baseInput,
      agentDiscussionContext: transcriptContext,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/TRANSCRIPT DUMP REJECTED/);
    expect(result.message).toMatch(/agentDiscussionContext/);
  });

  it('rejects proposals with raw transcript in description field', async () => {
    const transcriptDesc = [
      '[CISO]: We need to patch the token validator.',
      '[SRE]: Agreed, the bypass is critical.',
      '[QA]: I can write tests for it.',
      '',
    ].join('\n');

    const result = await createTicketProposal({
      ...baseInput,
      description: transcriptDesc,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/TRANSCRIPT DUMP REJECTED/);
  });

  it('emits ticket_proposal_transcript_rejected_total telemetry on rejection', async () => {
    const transcriptContext = [
      '[CISO]: We need to patch the token validator.',
      '[SRE]: Agreed, the bypass is critical.',
      '[QA]: I can write tests for it.',
      '',
    ].join('\n');

    await createTicketProposal({
      ...baseInput,
      agentDiscussionContext: transcriptContext,
    });

    expect(mockLogGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ticket_proposal_transcript_rejected_total',
        orgId: 'org-abc',
        agentId: 'nexus',
        title: baseInput.title,
      }),
    );
  });

  it('logs a warning when transcript is detected', async () => {
    const transcriptContext = [
      '[CISO]: We need to patch the token validator.',
      '[SRE]: Agreed, the bypass is critical.',
      '[QA]: I can write tests for it.',
      '',
    ].join('\n');

    await createTicketProposal({
      ...baseInput,
      agentDiscussionContext: transcriptContext,
    });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'nexus', field: 'agentDiscussionContext' }),
      expect.stringContaining('transcript_rejected'),
    );
  });

  it('accepts properly synthesized prose context', async () => {
    const result = await createTicketProposal({
      ...baseInput,
      agentDiscussionContext: 'CISO flagged a token validation bypass in src/auth/token.ts. Team agreed to add parameterised queries and input sanitisation to close CVE-2024-9999. SRE confirmed no performance regressions expected.',
    });

    // Should pass transcript validation (may fail later due to DB mock, but not on transcript)
    expect(result.message).not.toMatch(/TRANSCRIPT DUMP REJECTED/);
  });
});

describe('createTicketProposal — length enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects agentDiscussionContext exceeding 1500 chars', async () => {
    const longContext = 'A'.repeat(1501);

    const result = await createTicketProposal({
      ...baseInput,
      agentDiscussionContext: longContext,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/1500-character limit/);
  });

  it('rejects description exceeding 2000 chars', async () => {
    const longDesc = 'B'.repeat(2001);

    const result = await createTicketProposal({
      ...baseInput,
      description: longDesc,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/2000-character limit/);
  });

  it('accepts description exactly at the limit', async () => {
    const exactDesc = 'Fix the SQL injection in `src/db/query-builder.ts`. CVE-2024-1234.' + 'X'.repeat(2000 - 67);

    const { message } = await createTicketProposal({
      ...baseInput,
      description: exactDesc,
    });

    expect(message).not.toMatch(/character limit/);
  });
});

describe('createTicketProposal — fallback plan enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects idle proposals without fallbackPlan', async () => {
    const result = await createTicketProposal({
      ...baseInput,
      source: 'idle',
      fallbackPlan: undefined,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/fallbackPlan/);
  });

  it('emits agentops_fallback_missing telemetry for missing fallback on idle proposal', async () => {
    await createTicketProposal({
      ...baseInput,
      source: 'idle',
      fallbackPlan: undefined,
    });

    expect(mockLogGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agentops_fallback_missing' }),
    );
  });

  it('accepts idle proposals with a valid fallbackPlan', async () => {
    const result = await createTicketProposal({
      ...baseInput,
      source: 'idle',
      fallbackPlan: '**Fallback:** Roll back and apply WAF rules as interim protection.',
    });

    expect(result.message).not.toMatch(/fallbackPlan is required/);
  });

  it('does not require fallbackPlan for user-sourced proposals', async () => {
    const result = await createTicketProposal({
      ...baseInput,
      source: 'user',
      fallbackPlan: undefined,
    });

    expect(result.message).not.toMatch(/fallbackPlan is required/);
  });
});

describe('createTicketProposal — iteration budget injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits ticket_iteration_budget_applied_total for low-confidence proposals', async () => {
    // Low confidence: no context, generic title, no fallback, source=user so fallback not required
    await createTicketProposal({
      orgId: 'org-abc',
      kind: 'task' as const,
      title: 'Fix bug',
      description: 'Fix it',  // too short
      project: 'MyProject',
      agentId: 'nexus' as const,
      source: 'user' as const,
      agentDiscussionContext: undefined,
      fallbackPlan: undefined,
    });

    expect(mockLogGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ticket_iteration_budget_applied_total',
        orgId: 'org-abc',
      }),
    );
  });

  it('logs info when iteration budget is applied', async () => {
    await createTicketProposal({
      orgId: 'org-abc',
      kind: 'task' as const,
      title: 'Fix bug',
      description: 'Fix it',
      project: 'MyProject',
      agentId: 'nexus' as const,
      source: 'user' as const,
      agentDiscussionContext: undefined,
      fallbackPlan: undefined,
    });

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'nexus', orgId: 'org-abc', title: 'Fix bug' }),
      expect.stringContaining('iteration_budget_applied'),
    );
  });

  it('does not inject iteration budget for high-confidence proposals', async () => {
    await createTicketProposal({
      ...baseInput,
      source: 'user',
      agentDiscussionContext: 'CISO and SRE discussed token validation bypass in src/auth/token.ts. Agreed to add parameterised queries. CVE-2024-9999 is the relevant advisory.',
    });

    const budgetCall = mockLogGuardrailEvent.mock.calls.find(
      ([e]) => e.event === 'ticket_iteration_budget_applied_total',
    );
    expect(budgetCall).toBeUndefined();
  });
});
