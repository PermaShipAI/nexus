import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before importing timer
vi.mock('./activity.js', () => ({
  getLastHumanActivityTimestamp: vi.fn(),
  getLastIdleTimestamp: vi.fn(),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./throttle.js', () => ({
  computeThrottleLevel: vi.fn().mockResolvedValue({
    level: 'normal',
    pendingCount: 0,
    created: 0,
    resolved: 0,
    velocity: 1.0,
    backlogLevel: 'normal',
    velocityLevel: 'normal',
    reason: 'all signals normal',
  }),
  shouldCreateNewWork: vi.fn().mockResolvedValue(true),
}));

vi.mock('../agents/executor.js', () => ({
  executeAgent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../agents/registry.js', () => ({
  getAgent: vi.fn().mockReturnValue({ id: 'ciso', title: 'CISO' }),
}));

vi.mock('../bot/formatter.js', () => ({
  sendAgentMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../bot/interactions.js', () => ({
  sendApprovalMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../conversation/service.js', () => ({
  storeMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./service.js', () => ({
  queueSuggestion: vi.fn().mockResolvedValue({}),
}));

vi.mock('../config.js', () => ({
  config: {
    IDLE_TIMEOUT_MS: 1200000,
    DISCORD_CHANNEL_ID: 'test-channel',
  },
}));

vi.mock('../settings/service.js', () => ({
  isAutonomousMode: vi.fn().mockResolvedValue(false),
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock('../agents/types.js', () => ({
  AGENT_IDS: ['ciso', 'sre', 'qa-manager'],
}));

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock('../db/schema.js', () => ({
  workspaceLinks: {},
  pendingActions: {},
  activityLog: {},
  botSettings: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  count: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./backoff.js', () => ({
  BACKOFF_DELAYS_MS: [1200000, 3600000, 14400000, 43200000],
  getBackoffStep: vi.fn().mockResolvedValue(0),
  incrementBackoffStep: vi.fn().mockResolvedValue(undefined),
  resetBackoffStep: vi.fn().mockResolvedValue(undefined),
  getIdleInvocations24h: vi.fn().mockResolvedValue(0),
  getMaxIdlePer24h: vi.fn().mockResolvedValue(5),
  getEffectiveDailyBudget: vi.fn().mockResolvedValue(5),
}));

vi.mock('./allocator.js', () => ({
  allocateNextProject: vi.fn().mockResolvedValue(null),
}));

import { executeAgent } from '../agents/executor.js';
import { triggerIdleNow } from './timer.js';

const mockExecuteAgent = vi.mocked(executeAgent);

describe('triggerIdleNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeAgent without crashing', async () => {
    mockExecuteAgent.mockResolvedValue(null);
    await triggerIdleNow('org-1', 'chan-1');
    expect(mockExecuteAgent).toHaveBeenCalled();
  });

  it('passes the base idle prompt (regression: prompt should be valid string)', async () => {
    mockExecuteAgent.mockResolvedValue(null);
    await triggerIdleNow('org-1', 'chan-1');

    const call = mockExecuteAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(typeof call.userMessage).toBe('string');
    expect(call.userMessage).toContain('ticket-proposal');
  });

  it('does not include project constraint when no project allocated', async () => {
    mockExecuteAgent.mockResolvedValue(null);
    await triggerIdleNow('org-1', 'chan-1');

    const call = mockExecuteAgent.mock.calls[0]?.[0];
    expect(call.userMessage).not.toContain('You MUST propose a ticket for the');
  });
});
