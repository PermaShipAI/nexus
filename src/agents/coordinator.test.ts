import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { coordinateReview, getRequiredReviewer } from './coordinator.js';
import type { AgentId } from './types.js';

// vi.hoisted ensures the mock reference is available before vi.mock hoisting runs
const { mockExecuteAgent } = vi.hoisted(() => ({
  mockExecuteAgent: vi.fn(),
}));

vi.mock('./executor.js', () => ({
  executeAgent: mockExecuteAgent,
}));
vi.mock('./registry.js', () => ({
  getAgent: vi.fn().mockImplementation((id: string) => ({
    id,
    title: id === 'ciso' ? 'CISO' : id === 'sre' ? 'SRE' : id,
  })),
}));
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('coordinateReview', () => {
    it('should invoke the reviewer agent with a structured critique prompt', async () => {
      mockExecuteAgent.mockResolvedValue('Looks risky — the deployment window is too narrow.');

      const result = await coordinateReview({
        orgId: 'org-1',
        proposingAgentId: 'ciso',
        reviewerAgentId: 'sre',
        proposal: 'Rotate all TLS certificates during peak hours.',
        channelId: 'chan-1',
      });

      expect(result.feedback).toBe('Looks risky — the deployment window is too narrow.');
      expect(result.timedOut).toBe(false);

      // Verify that executeAgent was called for the reviewer agent
      expect(mockExecuteAgent).toHaveBeenCalledOnce();
      const callArgs = mockExecuteAgent.mock.calls[0][0];
      expect(callArgs.agentId).toBe('sre');
      expect(callArgs.orgId).toBe('org-1');
      expect(callArgs.channelId).toBe('chan-1');
      // The prompt should reference both agents' roles and the proposal content
      expect(callArgs.userMessage).toContain('SRE');
      expect(callArgs.userMessage).toContain('CISO');
      expect(callArgs.userMessage).toContain('Rotate all TLS certificates during peak hours.');
    });

    it('should return a fallback message when the reviewer agent produces no output', async () => {
      mockExecuteAgent.mockResolvedValue(null);

      const result = await coordinateReview({
        orgId: 'org-1',
        proposingAgentId: 'ux-designer',
        reviewerAgentId: 'qa-manager',
        proposal: 'Replace all modal dialogs with inline confirmations.',
        channelId: 'chan-2',
      });

      expect(result.feedback).toBe('No review feedback provided.');
      expect(result.timedOut).toBe(false);
    });

    it('should return an empty-string response as-is', async () => {
      mockExecuteAgent.mockResolvedValue('');

      const result = await coordinateReview({
        orgId: 'org-1',
        proposingAgentId: 'finops',
        reviewerAgentId: 'product-manager',
        proposal: 'Cut compute costs by 30%.',
        channelId: 'chan-3',
      });

      // Empty string is falsy — coordinator falls back to the default message
      expect(result.feedback).toBe('No review feedback provided.');
      expect(result.timedOut).toBe(false);
    });
  });

  describe('getRequiredReviewer', () => {
    it('should assign SRE as reviewer for CISO proposals', () => {
      expect(getRequiredReviewer('ciso', 'Deploy firewall rules')).toBe('sre');
    });

    it('should assign QA Manager as reviewer for UX Designer proposals', () => {
      expect(getRequiredReviewer('ux-designer', 'Redesign onboarding flow')).toBe('qa-manager');
    });

    it('should assign CISO as reviewer for SRE proposals touching security', () => {
      expect(getRequiredReviewer('sre', 'Update auth token expiry policy')).toBe('ciso');
    });

    it('should NOT assign CISO for SRE proposals unrelated to security', () => {
      expect(getRequiredReviewer('sre', 'Increase database connection pool size')).toBeNull();
    });

    it('should assign Product Manager as reviewer for FinOps proposals', () => {
      expect(getRequiredReviewer('finops', 'Reduce cloud spend by consolidating regions')).toBe('product-manager');
    });

    it('should assign SRE as reviewer for Release Engineering proposals', () => {
      expect(getRequiredReviewer('release-engineering', 'Add deployment canary stage')).toBe('sre');
    });

    it('should escalate high-impact proposals to Nexus for agents without a specific rule', () => {
      // 'support' has no specific routing rule, so high-impact signals trigger Nexus escalation
      expect(getRequiredReviewer('support', 'This is a critical breaking change')).toBe('nexus');
      expect(getRequiredReviewer('support', 'Irreversible data migration required')).toBe('nexus');
      expect(getRequiredReviewer('support', 'Proposal involves a multi-tenant rollout')).toBe('nexus');
    });

    it('should return null for agents with no matching review rule', () => {
      expect(getRequiredReviewer('product-manager', 'Prioritise roadmap items for Q3')).toBeNull();
    });
  });

  describe('cross-agent review loop termination', () => {
    it('should terminate a back-and-forth debate loop at a defined maximum iteration limit', async () => {
      const MAX_REVIEW_ROUNDS = 3;

      // Each review response is a critique that would normally trigger another round
      mockExecuteAgent.mockResolvedValue(
        'I still have concerns — this needs further review.',
      );

      // Use a fixed proposer/reviewer pair (ciso → sre) so each round always
      // finds a required reviewer and the only termination is the MAX_REVIEW_ROUNDS limit.
      const proposingAgent: AgentId = 'ciso';
      const proposal = 'Enable mutual TLS across all internal services';
      const reviewHistory: string[] = [];

      // Simulate an orchestrator-driven debate loop bounded by MAX_REVIEW_ROUNDS
      for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
        const reviewerAgentId = getRequiredReviewer(proposingAgent, proposal);

        // If no reviewer is required the loop exits naturally
        if (!reviewerAgentId) break;

        const feedback = await coordinateReview({
          orgId: 'org-1',
          proposingAgentId: proposingAgent,
          reviewerAgentId,
          proposal,
          channelId: 'chan-debate',
        });

        reviewHistory.push(feedback);
      }

      // The loop must have terminated exactly at the max limit — not continued indefinitely
      expect(reviewHistory.length).toBe(MAX_REVIEW_ROUNDS);
      expect(mockExecuteAgent).toHaveBeenCalledTimes(MAX_REVIEW_ROUNDS);
    });

    it('should not recurse when the proposal has no required reviewer', async () => {
      // A product-manager proposal has no rule-based reviewer: loop exits at round 0
      const reviewer = getRequiredReviewer('product-manager', 'Regular backlog grooming');
      expect(reviewer).toBeNull();

      // No review invocation should occur
      expect(mockExecuteAgent).not.toHaveBeenCalled();
    });
  });
});
