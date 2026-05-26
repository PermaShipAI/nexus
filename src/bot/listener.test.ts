import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processWebhookMessage } from './listener.js';
import { routeMessage } from '../router/index.js';
import { executeAgent } from '../agents/executor.js';
import { getAgent } from '../agents/registry.js';
import { sendAgentMessage } from './formatter.js';
import { logGuardrailEvent } from '../telemetry/index.js';

const mockGetContext = vi.fn();
const mockShouldPrompt = vi.fn();
const mockSetInternalChannel = vi.fn();
const mockLinkWorkspace = vi.fn();
const mockGetOrgName = vi.fn();
const mockActivateWorkspace = vi.fn();

vi.mock('../adapters/registry.js', () => ({
  getTenantResolver: () => ({
    getContext: mockGetContext,
    shouldPrompt: mockShouldPrompt,
    setInternalChannel: mockSetInternalChannel,
    linkWorkspace: mockLinkWorkspace,
    getOrgName: mockGetOrgName,
    activateWorkspace: mockActivateWorkspace,
  }),
  getCommunicationAdapter: () => ({
    addReaction: vi.fn().mockResolvedValue({ success: true }),
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    renameThread: vi.fn().mockResolvedValue({ success: true }),
  }),
}));
vi.mock('../router/index.js');
vi.mock('../agents/executor.js');
vi.mock('../agents/registry.js');
vi.mock('./formatter.js', () => ({
  sendAgentMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../conversation/service.js', () => ({
  storeMessage: vi.fn().mockResolvedValue({}),
}));
vi.mock('../idle/activity.js', () => ({
  logActivity: vi.fn().mockResolvedValue({}),
}));
vi.mock('../settings/service.js', () => ({
  isPublicChannel: vi.fn().mockResolvedValue(false),
  isAutonomousMode: vi.fn().mockResolvedValue(false),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../telemetry/index.js', () => ({
  logGuardrailEvent: vi.fn(),
}));

describe('listener', () => {
  const mockUnified: any = {
    id: 'msg-1',
    content: 'Hello',
    channelId: 'discord:chan-1',
    workspaceId: 'work-1',
    authorId: 'user-1',
    authorName: 'Alice',
    platform: 'discord',
    isThread: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should ignore message from unlinked workspace', async () => {
    mockGetContext.mockResolvedValue(null);
    mockShouldPrompt.mockReturnValue(false);

    await processWebhookMessage(mockUnified);

    expect(routeMessage).not.toHaveBeenCalled();
  });

  it('should process message for linked workspace in internal channel', async () => {
    const mockContext: any = {
      orgId: 'org-1',
      internalChannelId: 'chan-1',
    };
    mockGetContext.mockResolvedValue(mockContext);
    vi.mocked(routeMessage).mockResolvedValue([{ agentId: 'nexus', subMessage: 'Hello', confidenceScore: 0.9 } as any]);
    vi.mocked(executeAgent).mockResolvedValue('AI Response');
    vi.mocked(getAgent).mockReturnValue({ title: 'Nexus Director' } as any);

    await processWebhookMessage(mockUnified);

    expect(routeMessage).toHaveBeenCalled();
    expect(executeAgent).toHaveBeenCalled();
    expect(sendAgentMessage).toHaveBeenCalledWith(
      'discord:chan-1',
      'Nexus Director',
      'AI Response',
      'org-1'
    );
  });

  it('should handle !autonomous command', async () => {
    const mockContext: any = {
      orgId: 'org-1',
      internalChannelId: 'chan-1',
    };
    mockGetContext.mockResolvedValue(mockContext);
    const cmdMessage = { ...mockUnified, content: '!autonomous on' };

    await processWebhookMessage(cmdMessage);

    expect(sendAgentMessage).toHaveBeenCalledWith(
      'discord:chan-1',
      'System',
      expect.stringMatching(/Autonomous mode .*enabled/i),
      'org-1'
    );
  });

  it('should send generic microcopy and emit telemetry when agent returns [waiting_for_human:]', async () => {
    const mockContext: any = {
      orgId: 'org-1',
      internalChannelId: 'chan-1',
    };
    mockGetContext.mockResolvedValue(mockContext);
    vi.mocked(routeMessage).mockResolvedValue([{ agentId: 'nexus', subMessage: 'Hello', confidenceScore: 0.9 } as any]);
    vi.mocked(executeAgent).mockResolvedValue('[waiting_for_human:]');
    vi.mocked(getAgent).mockReturnValue({ title: 'Nexus Director' } as any);

    const { storeMessage } = await import('../conversation/service.js');

    await processWebhookMessage(mockUnified);

    expect(sendAgentMessage).toHaveBeenCalledWith(
      'discord:chan-1',
      'Nexus Director',
      expect.stringContaining('manual human approval'),
      'org-1',
    );
    expect(vi.mocked(logGuardrailEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'waiting_for_human_approval_displayed',
        agentId: 'nexus',
        channelId: 'discord:chan-1',
        orgId: 'org-1',
        requiredRole: undefined,
      }),
    );
    // storeMessage should NOT be called for the agent's response
    expect(vi.mocked(storeMessage)).toHaveBeenCalledTimes(1); // only the incoming user message
  });

  it('should send role-specific microcopy when agent returns [waiting_for_human:CISO]', async () => {
    const mockContext: any = {
      orgId: 'org-1',
      internalChannelId: 'chan-1',
    };
    mockGetContext.mockResolvedValue(mockContext);
    vi.mocked(routeMessage).mockResolvedValue([{ agentId: 'ciso', subMessage: 'Fix vuln', confidenceScore: 0.9 } as any]);
    vi.mocked(executeAgent).mockResolvedValue('[waiting_for_human:CISO]');
    vi.mocked(getAgent).mockReturnValue({ title: 'CISO' } as any);

    await processWebhookMessage(mockUnified);

    expect(sendAgentMessage).toHaveBeenCalledWith(
      'discord:chan-1',
      'CISO',
      expect.stringContaining('CISO approval'),
      'org-1',
    );
    expect(vi.mocked(logGuardrailEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'waiting_for_human_approval_displayed',
        requiredRole: 'CISO',
      }),
    );
  });
});
