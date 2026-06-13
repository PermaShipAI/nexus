import { vi, afterEach } from 'vitest';

// Mock gemini client to prevent GoogleGenAI constructor from throwing without API key
vi.mock('../gemini/client.js', () => ({
  callGemini: vi.fn().mockResolvedValue(''),
}));

const { mockLogAdminClarification } = vi.hoisted(() => ({
  mockLogAdminClarification: vi.fn(),
}));

vi.mock('../../agents/telemetry/logger.js', () => ({
  logAdministrativeIntentClarificationEvent: mockLogAdminClarification,
  logRoutingDecision: vi.fn(),
  logSecurityEvent: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

process.env.INTENT_MOCK_MODE = 'true';

import { routeIntent } from './router';
import { RequestContext } from '../rbac/types';

const privateAdminContext: RequestContext = {
  platformUserId: 'admin-user',
  platform: 'discord',
  channelType: 'private',
  role: 'ADMIN',
  messageId: 'msg-router-001',
};

const publicOwnerContext: RequestContext = {
  platformUserId: 'owner-user',
  platform: 'discord',
  channelType: 'public',
  role: 'OWNER',
  messageId: 'msg-router-002',
};

const privateMemberContext: RequestContext = {
  platformUserId: 'member-user',
  platform: 'discord',
  channelType: 'private',
  role: 'MEMBER',
  messageId: 'msg-router-003',
};

describe('routeIntent', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes InvestigateBug for MEMBER in private channel', async () => {
    const result = await routeIntent('investigate the login bug', privateMemberContext);
    expect(result.allowed).toBe(true);
    expect(result.intent?.kind).toBe('InvestigateBug');
  });

  it('blocks ManageProject in public channel even for OWNER', async () => {
    const result = await routeIntent('delete the staging project', publicOwnerContext);
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('PublicChannelRestriction');
    expect(result.userMessage).toContain('public channel');
  });

  it('returns clarification for low confidence messages', async () => {
    const result = await routeIntent('low confidence message xyz123', privateAdminContext);
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('LowConfidence');
    expect(result.userMessage).toContain('clarify');
  });

  it('requires confirmation for ManageProject', async () => {
    const result = await routeIntent('manage the alpha project', privateAdminContext);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('blocks VIEWER from InvestigateBug', async () => {
    const viewerContext: RequestContext = {
      ...privateMemberContext,
      role: 'VIEWER',
      messageId: 'msg-router-004',
    };
    const result = await routeIntent('investigate the login bug', viewerContext);
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('InsufficientRole');
  });

  it('returns clarification with actionable options for ambiguous AdministrativeAction (score 0.45)', async () => {
    const result = await routeIntent('change some system settings', privateAdminContext);
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('LowConfidence');
    expect(result.userMessage).toContain('setting');
    expect(result.actionableOptions).toBeDefined();
    expect(result.actionableOptions!.length).toBeGreaterThan(0);
  });

  it('calls logAdministrativeIntentClarificationEvent for ambiguous AdministrativeAction', async () => {
    await routeIntent('change some system settings', privateAdminContext);
    expect(mockLogAdminClarification).toHaveBeenCalledWith(
      expect.objectContaining({ confidenceScore: 0.45 }),
    );
  });

  it('does NOT call logAdministrativeIntentClarificationEvent for low-confidence Unknown intent', async () => {
    await routeIntent('low confidence message xyz123', privateAdminContext);
    expect(mockLogAdminClarification).not.toHaveBeenCalled();
  });

  it('routes explicit AdministrativeAction (score 0.97) to agent without fallback', async () => {
    const result = await routeIntent('enable autonomous mode', privateAdminContext);
    expect(result.allowed).toBe(true);
    expect(result.intent?.kind).toBe('AdministrativeAction');
    expect(result.requiresConfirmation).toBe(true);
  });
});
