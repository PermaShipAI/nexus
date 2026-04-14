import { vi } from 'vitest';

// Mock gemini client to prevent GoogleGenAI constructor from throwing without API key
vi.mock('../gemini/client.js', () => ({
  callGemini: vi.fn().mockResolvedValue(''),
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
});

describe('AdministrativeAction routing', () => {
  it('routes high-confidence AdministrativeAction with requiresConfirmation', async () => {
    const result = await routeIntent('enable autonomous mode', privateAdminContext);
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.intent?.kind).toBe('AdministrativeAction');
  });
  it('blocks low-confidence AdministrativeAction with LowConfidence', async () => {
    const result = await routeIntent('change some setting maybe', privateAdminContext);
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('LowConfidence');
  });
});
