import '../tests/env.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./service.js', () => ({
  getActiveMissionsDueForHeartbeat: vi.fn().mockResolvedValue([]),
  getMissionItems: vi.fn().mockResolvedValue([]),
  getMissionProjects: vi.fn().mockResolvedValue([]),
  getMissionById: vi.fn().mockResolvedValue(null),
  recordHeartbeat: vi.fn().mockResolvedValue(undefined),
  updateMissionItem: vi.fn().mockResolvedValue({}),
  createMission: vi.fn().mockResolvedValue({ id: 'new-mission-id' }),
  getMissionRoster: vi.fn().mockResolvedValue([]),
  getMissionPhaseProgress: vi.fn().mockResolvedValue([]),
}));

vi.mock('./lifecycle.js', () => ({
  checkMissionCompletion: vi.fn().mockResolvedValue(false),
  planMission: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../agents/executor.js', () => ({
  executeAgent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../bot/formatter.js', () => ({
  sendAgentMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../local/communication-adapter.js', () => ({
  localBus: { emit: vi.fn() },
}));

vi.mock('../conversation/service.js', () => ({
  storeMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../router/index.js', () => ({
  routeMessage: vi.fn().mockResolvedValue([{ agentId: 'sre' }]),
}));

vi.mock('../agents/registry.js', () => ({
  getAgent: vi.fn().mockReturnValue({ id: 'sre', title: 'SRE Agent' }),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../settings/service.js', () => ({
  isAgentsPaused: vi.fn().mockResolvedValue(false),
}));

vi.mock('../db/index.js', () => {
  const mockQuery = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    orderBy: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(mockQuery),
      update: vi.fn().mockReturnValue(mockQuery),
    },
  };
});

import {
  onMissionItemChanged,
  startMissionScheduler,
  stopMissionScheduler,
} from './scheduler.js';
import { getMissionById } from './service.js';

const mockGetMissionById = getMissionById as ReturnType<typeof vi.fn>;

describe('onMissionItemChanged — debounce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stopMissionScheduler();
  });

  it('schedules exactly one heartbeat per mission even with rapid calls', async () => {
    mockGetMissionById.mockResolvedValue(null); // no heartbeat fires

    // Call three times in quick succession
    onMissionItemChanged('mission-a');
    onMissionItemChanged('mission-a');
    onMissionItemChanged('mission-a');

    // Only one timeout should be pending (previous ones were cancelled)
    expect(mockGetMissionById).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    // After the debounce fires, only one lookup should occur
    expect(mockGetMissionById).toHaveBeenCalledTimes(1);
    expect(mockGetMissionById).toHaveBeenCalledWith('mission-a');
  });

  it('schedules independent heartbeats for different missions', async () => {
    mockGetMissionById.mockResolvedValue(null);

    onMissionItemChanged('mission-alpha');
    onMissionItemChanged('mission-beta');

    await vi.runAllTimersAsync();

    expect(mockGetMissionById).toHaveBeenCalledTimes(2);
    expect(mockGetMissionById).toHaveBeenCalledWith('mission-alpha');
    expect(mockGetMissionById).toHaveBeenCalledWith('mission-beta');
  });

  it('does not trigger heartbeat when mission is not found', async () => {
    const { executeAgent } = await import('../agents/executor.js');
    mockGetMissionById.mockResolvedValue(null);

    onMissionItemChanged('missing-mission');
    await vi.runAllTimersAsync();

    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('does not trigger heartbeat when mission status is not active', async () => {
    const { executeAgent } = await import('../agents/executor.js');
    mockGetMissionById.mockResolvedValue({
      id: 'mission-x',
      orgId: 'org-1',
      status: 'completed',
      channelId: 'mission:mission-x',
      heartbeatIntervalMs: 600_000,
    });

    onMissionItemChanged('mission-x');
    await vi.runAllTimersAsync();

    expect(executeAgent).not.toHaveBeenCalled();
  });
});

describe('startMissionScheduler / stopMissionScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopMissionScheduler();
    vi.useRealTimers();
  });

  it('starts polling and can be stopped cleanly without throwing', () => {
    expect(() => startMissionScheduler()).not.toThrow();
    expect(() => stopMissionScheduler()).not.toThrow();
  });

  it('stop is idempotent — calling stop twice does not throw', () => {
    startMissionScheduler();
    stopMissionScheduler();
    expect(() => stopMissionScheduler()).not.toThrow();
  });
});
