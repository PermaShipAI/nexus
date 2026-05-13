import '../tests/env.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── DB mock ──────────────────────────────────────────────────────────────────
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../db/index.js', () => ({ db: mockDb }));
vi.mock('../db/schema.js', () => ({
  missions: {},
  missionItems: {},
  missionProjects: {},
  missionAgents: {},
  localProjects: {},
  tickets: {},
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ eq: val })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  lte: vi.fn(),
  inArray: vi.fn(),
}));

// ── Service mock ─────────────────────────────────────────────────────────────
vi.mock('./service.js', () => ({
  getActiveMissionsDueForHeartbeat: vi.fn(),
  getMissionItems: vi.fn(),
  getMissionProjects: vi.fn(),
  getMissionById: vi.fn(),
  recordHeartbeat: vi.fn(),
  updateMissionItem: vi.fn(),
  createMission: vi.fn(),
  getMissionPhaseProgress: vi.fn(),
  getMissionRoster: vi.fn(),
}));

// ── Lifecycle mock ────────────────────────────────────────────────────────────
vi.mock('./lifecycle.js', () => ({
  checkMissionCompletion: vi.fn(),
  planMission: vi.fn(),
}));

// ── Agent + comms mocks ───────────────────────────────────────────────────────
vi.mock('../agents/executor.js', () => ({
  executeAgent: vi.fn(),
}));
vi.mock('../bot/formatter.js', () => ({
  sendAgentMessage: vi.fn(),
}));
vi.mock('../local/communication-adapter.js', () => ({
  localBus: { emit: vi.fn() },
}));
vi.mock('../conversation/service.js', () => ({
  storeMessage: vi.fn(),
}));
vi.mock('../router/index.js', () => ({
  routeMessage: vi.fn(),
}));
vi.mock('../agents/registry.js', () => ({
  getAgent: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../settings/service.js', () => ({
  isAgentsPaused: vi.fn(),
  getSetting: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import {
  onMissionItemChanged,
  startMissionScheduler,
  stopMissionScheduler,
} from './scheduler.js';
import {
  getActiveMissionsDueForHeartbeat,
  getMissionItems,
  getMissionProjects,
  getMissionById,
  recordHeartbeat,
  updateMissionItem,
  createMission,
  getMissionPhaseProgress,
  getMissionRoster,
} from './service.js';
import { checkMissionCompletion, planMission } from './lifecycle.js';
import { executeAgent } from '../agents/executor.js';
import { sendAgentMessage } from '../bot/formatter.js';
import { storeMessage } from '../conversation/service.js';
import { routeMessage } from '../router/index.js';
import { getAgent } from '../agents/registry.js';
import { isAgentsPaused } from '../settings/service.js';

// ── Typed mocks ───────────────────────────────────────────────────────────────
const mockGetActiveMissions = vi.mocked(getActiveMissionsDueForHeartbeat);
const mockGetMissionItems = vi.mocked(getMissionItems);
const mockGetMissionProjects = vi.mocked(getMissionProjects);
const mockGetMissionById = vi.mocked(getMissionById);
const mockRecordHeartbeat = vi.mocked(recordHeartbeat);
const mockUpdateMissionItem = vi.mocked(updateMissionItem);
const mockCreateMission = vi.mocked(createMission);
const mockGetPhaseProgress = vi.mocked(getMissionPhaseProgress);
const mockGetMissionRoster = vi.mocked(getMissionRoster);
const mockCheckCompletion = vi.mocked(checkMissionCompletion);
const mockPlanMission = vi.mocked(planMission);
const mockExecuteAgent = vi.mocked(executeAgent);
const mockSendAgentMessage = vi.mocked(sendAgentMessage);
const mockStoreMessage = vi.mocked(storeMessage);
const mockRouteMessage = vi.mocked(routeMessage);
const mockGetAgent = vi.mocked(getAgent);
const mockIsAgentsPaused = vi.mocked(isAgentsPaused);

// ── Fixtures ──────────────────────────────────────────────────────────────────
const ORG_ID = '00000000-0000-0000-0000-000000000001';
const MISSION_ID = '00000000-0000-0000-0000-000000000002';

const baseMission = {
  id: MISSION_ID,
  orgId: ORG_ID,
  channelId: `mission:${MISSION_ID}`,
  title: 'Build authentication',
  description: 'Add login/signup flows',
  status: 'active' as const,
  heartbeatIntervalMs: 600_000,
  cronExpression: null,
  nextHeartbeatAt: new Date(0),
  lastHeartbeatAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  completedAt: null,
  cancelledAt: null,
  autonomousMode: null,
};

// Minimal select chain: .select({...}).from(x).where(y).limit(n) → resolves to rows
function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('onMissionItemChanged', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetMissionById.mockResolvedValue(baseMission);
    // Provide minimal data so heartbeat completes without error
    mockGetMissionItems.mockResolvedValue([]);
    mockGetMissionProjects.mockResolvedValue([]);
    mockDb.select.mockReturnValue(makeSelectChain([]));
    mockGetPhaseProgress.mockResolvedValue([]);
    mockCheckCompletion.mockResolvedValue(false);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockGetMissionRoster.mockResolvedValue([]);
    mockIsAgentsPaused.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    stopMissionScheduler();
  });

  it('schedules an early heartbeat after the debounce period', async () => {
    onMissionItemChanged(MISSION_ID);

    // Before debounce fires — no heartbeat yet
    expect(mockGetMissionById).not.toHaveBeenCalled();

    // Advance past the 10s debounce
    await vi.advanceTimersByTimeAsync(10_001);

    expect(mockGetMissionById).toHaveBeenCalledWith(MISSION_ID);
  });

  it('debounces rapid successive calls — fires only once', async () => {
    onMissionItemChanged(MISSION_ID);
    onMissionItemChanged(MISSION_ID);
    onMissionItemChanged(MISSION_ID);

    await vi.advanceTimersByTimeAsync(10_001);

    // Mission lookup happens exactly once despite three calls
    expect(mockGetMissionById).toHaveBeenCalledTimes(1);
  });

  it('resets the debounce timer on each call', async () => {
    onMissionItemChanged(MISSION_ID);
    await vi.advanceTimersByTimeAsync(8_000);

    // Second call resets the timer
    onMissionItemChanged(MISSION_ID);
    await vi.advanceTimersByTimeAsync(5_000);

    // Only 5s have passed since the second call — should not have fired yet
    expect(mockGetMissionById).not.toHaveBeenCalled();

    // Advance to complete the debounce after the second call
    await vi.advanceTimersByTimeAsync(5_001);
    expect(mockGetMissionById).toHaveBeenCalledTimes(1);
  });

  it('does not trigger heartbeat for non-active missions', async () => {
    mockGetMissionById.mockResolvedValue({ ...baseMission, status: 'completed' });

    onMissionItemChanged(MISSION_ID);
    await vi.advanceTimersByTimeAsync(10_001);

    // getMissionById is called, but heartbeat functions are NOT
    expect(mockGetMissionById).toHaveBeenCalledWith(MISSION_ID);
    expect(mockGetMissionItems).not.toHaveBeenCalled();
  });

  it('handles getMissionById returning null without throwing', async () => {
    mockGetMissionById.mockResolvedValue(null);

    onMissionItemChanged(MISSION_ID);

    await expect(vi.advanceTimersByTimeAsync(10_001)).resolves.not.toThrow();
    expect(mockGetMissionItems).not.toHaveBeenCalled();
  });

  it('supports independent debounce timers per mission', async () => {
    const MISSION_B = '00000000-0000-0000-0000-000000000003';
    mockGetMissionById.mockImplementation(async (id) =>
      id === MISSION_ID
        ? baseMission
        : { ...baseMission, id: MISSION_B, channelId: `mission:${MISSION_B}` },
    );

    onMissionItemChanged(MISSION_ID);
    onMissionItemChanged(MISSION_B);

    await vi.advanceTimersByTimeAsync(10_001);

    expect(mockGetMissionById).toHaveBeenCalledWith(MISSION_ID);
    expect(mockGetMissionById).toHaveBeenCalledWith(MISSION_B);
    expect(mockGetMissionById).toHaveBeenCalledTimes(2);
  });
});

describe('startMissionScheduler / stopMissionScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetActiveMissions.mockResolvedValue([]);
    mockIsAgentsPaused.mockResolvedValue(false);
  });

  afterEach(() => {
    stopMissionScheduler();
    vi.useRealTimers();
  });

  it('triggers initial heartbeat check after 45s', async () => {
    await startMissionScheduler();

    // No check before 45s
    expect(mockGetActiveMissions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(45_001);

    expect(mockGetActiveMissions).toHaveBeenCalled();
  });

  it('polls on 30s interval after startup', async () => {
    await startMissionScheduler();

    // Skip past initial 45s delay
    await vi.advanceTimersByTimeAsync(46_000);
    const callsAfterInit = mockGetActiveMissions.mock.calls.length;

    // Each 30s poll fires checkMissionHeartbeats, which calls getActiveMissionsDueForHeartbeat
    // twice per invocation (once for pause-check orgId, once for due missions list)
    await vi.advanceTimersByTimeAsync(30_000);
    const callsAfterFirst = mockGetActiveMissions.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(callsAfterInit);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockGetActiveMissions.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('stopMissionScheduler prevents further polling', async () => {
    await startMissionScheduler();
    await vi.advanceTimersByTimeAsync(46_000);
    const callCount = mockGetActiveMissions.mock.calls.length;

    stopMissionScheduler();

    // Advance well past a poll interval — no new calls
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockGetActiveMissions.mock.calls.length).toBe(callCount);
  });

  it('skips heartbeat processing when no missions are due', async () => {
    mockGetActiveMissions.mockResolvedValue([]);

    await startMissionScheduler();
    await vi.advanceTimersByTimeAsync(46_000);

    // No items/projects fetched because there were no due missions
    expect(mockGetMissionItems).not.toHaveBeenCalled();
  });

  it('skips all heartbeats when agents are paused', async () => {
    mockIsAgentsPaused.mockResolvedValue(true);
    mockGetActiveMissions.mockResolvedValue([baseMission]);

    await startMissionScheduler();
    await vi.advanceTimersByTimeAsync(46_000);

    // Even with due missions, nothing is processed
    expect(mockGetMissionItems).not.toHaveBeenCalled();
  });
});

describe('mission heartbeat: stalled items', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockIsAgentsPaused.mockResolvedValue(false);
    mockGetMissionProjects.mockResolvedValue([]);
    mockDb.select.mockReturnValue(makeSelectChain([]));
    mockGetPhaseProgress.mockResolvedValue([]);
    mockCheckCompletion.mockResolvedValue(false);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockUpdateMissionItem.mockResolvedValue(null);
    mockGetMissionRoster.mockResolvedValue([]);
    mockExecuteAgent.mockResolvedValue(null);
    mockSendAgentMessage.mockResolvedValue(undefined);
    mockStoreMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopMissionScheduler();
    vi.useRealTimers();
  });

  it('sends re-plan prompt to Nexus when all active items are stalled', async () => {
    const stalledItems = [
      {
        id: 'item-1',
        missionId: MISSION_ID,
        title: 'Implement OAuth login',
        description: 'Add OAuth2 support',
        status: 'in_progress',
        heartbeatCount: 3,
        isPhase: false,
        parentId: null,
        sortOrder: 0,
        assignedAgentId: null,
        completedByAgentId: null,
        verifiedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];

    mockGetActiveMissions.mockResolvedValue([baseMission]);
    mockGetMissionItems.mockResolvedValue(stalledItems as any);

    await startMissionScheduler();
    await vi.advanceTimersByTimeAsync(46_000);

    // Nexus re-plan request should have been fired
    expect(mockExecuteAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'nexus',
        userMessage: expect.stringContaining('stalled'),
      }),
    );
    // Heartbeat should be rescheduled even in stalled path
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(
      MISSION_ID,
      expect.any(Date),
    );
  });

  it('skips heartbeat prompt when ticket for focus item is still running', async () => {
    const activeItem = {
      id: 'item-1',
      missionId: MISSION_ID,
      title: 'Add user authentication system',
      description: 'Implement login',
      status: 'in_progress',
      heartbeatCount: 1,
      isPhase: false,
      parentId: null,
      sortOrder: 0,
      assignedAgentId: null,
      completedByAgentId: null,
      verifiedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };

    // A running ticket whose title overlaps with the focus item keywords
    const runningTickets = [
      {
        executionStatus: 'running',
        title: 'Add user authentication system',
      },
    ];

    mockGetActiveMissions.mockResolvedValue([baseMission]);
    mockGetMissionItems.mockResolvedValue([activeItem] as any);
    // First db.select call = reconcile orgTickets, second = running ticket check
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))   // reconcile: no tickets
      .mockReturnValueOnce(makeSelectChain([]))   // failure escalation check
      .mockReturnValueOnce(makeSelectChain(runningTickets)); // running ticket guard

    await startMissionScheduler();
    await vi.advanceTimersByTimeAsync(46_000);

    // Should NOT invoke executeAgent because ticket is already running
    expect(mockExecuteAgent).not.toHaveBeenCalled();
    // But heartbeat IS rescheduled
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(MISSION_ID, expect.any(Date));
  });
});

describe('mission heartbeat: completion and recurrence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockIsAgentsPaused.mockResolvedValue(false);
    mockGetMissionProjects.mockResolvedValue([]);
    mockDb.select.mockReturnValue(makeSelectChain([]));
    mockGetPhaseProgress.mockResolvedValue([]);
    mockUpdateMissionItem.mockResolvedValue(null);
    mockGetMissionRoster.mockResolvedValue([]);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockExecuteAgent.mockResolvedValue(null);
    mockSendAgentMessage.mockResolvedValue(undefined);
    mockStoreMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopMissionScheduler();
    vi.useRealTimers();
  });

  it('sends completion message and does not re-plan when mission is complete', async () => {
    mockGetActiveMissions.mockResolvedValue([baseMission]);
    mockGetMissionItems.mockResolvedValue([]);
    mockCheckCompletion.mockResolvedValue(true);

    await startMissionScheduler();
    await vi.advanceTimersByTimeAsync(46_000);

    expect(mockSendAgentMessage).toHaveBeenCalledWith(
      baseMission.channelId,
      'Nexus',
      expect.stringContaining('complete'),
      ORG_ID,
    );
    // No recurring spawn because cronExpression is null
    expect(mockCreateMission).not.toHaveBeenCalled();
  });

  it('spawns a recurring mission when cronExpression is set and mission completes', async () => {
    const recurringMission = { ...baseMission, cronExpression: '0 9 * * 1' };
    const newMission = {
      ...baseMission,
      id: '00000000-0000-0000-0000-000000000099',
      channelId: 'mission:00000000-0000-0000-0000-000000000099',
    };

    mockGetActiveMissions.mockResolvedValue([recurringMission]);
    mockGetMissionItems.mockResolvedValue([]);
    mockCheckCompletion.mockResolvedValue(true);
    mockCreateMission.mockResolvedValue(newMission as any);
    mockPlanMission.mockResolvedValue(undefined);

    await startMissionScheduler();
    await vi.advanceTimersByTimeAsync(46_000);

    expect(mockCreateMission).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        title: recurringMission.title,
        cronExpression: '0 9 * * 1',
      }),
    );
  });
});

describe('reconcileItemsWithTickets: keyword matching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockIsAgentsPaused.mockResolvedValue(false);
    mockGetMissionProjects.mockResolvedValue([]);
    mockGetPhaseProgress.mockResolvedValue([]);
    mockCheckCompletion.mockResolvedValue(false);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockUpdateMissionItem.mockResolvedValue(null);
    mockGetMissionRoster.mockResolvedValue([]);
    mockExecuteAgent.mockResolvedValue(null);
    mockSendAgentMessage.mockResolvedValue(undefined);
    mockStoreMessage.mockResolvedValue(undefined);
    mockRouteMessage.mockResolvedValue([{ agentId: 'sre' }] as any);
    mockGetAgent.mockReturnValue({ id: 'sre', title: 'SRE' } as any);
  });

  afterEach(() => {
    stopMissionScheduler();
    vi.useRealTimers();
  });

  it('auto-marks pending item as agent_complete when matching ticket is review_approved', async () => {
    const pendingItem = {
      id: 'item-1',
      missionId: MISSION_ID,
      title: 'Implement OAuth login support',
      description: 'Add OAuth2 support',
      status: 'pending',
      heartbeatCount: 0,
      isPhase: false,
      parentId: null,
      sortOrder: 0,
      assignedAgentId: null,
      completedByAgentId: null,
      verifiedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };

    const approvedTicket = {
      id: 'ticket-1',
      title: 'Implement OAuth login support',
      executionStatus: 'review_approved',
      executionBranch: 'feat/oauth',
      mergeStatus: null,
      executionReview: 'Looks good',
    };

    mockGetActiveMissions.mockResolvedValue([baseMission]);
    // First getMissionItems call (before reconcile) returns pending item
    // Second getMissionItems call (after reconcile re-fetch) returns updated item
    mockGetMissionItems
      .mockResolvedValueOnce([pendingItem] as any)
      .mockResolvedValueOnce([{ ...pendingItem, status: 'agent_complete' }] as any);

    // The first db.select in reconcile fetches orgTickets
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([approvedTicket]))  // reconcile orgTickets
      .mockReturnValueOnce(makeSelectChain([]))                // failure escalation check
      .mockReturnValueOnce(makeSelectChain([]));               // running ticket guard

    await startMissionScheduler();
    await vi.advanceTimersByTimeAsync(46_000);

    expect(mockUpdateMissionItem).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({
        status: 'agent_complete',
        completedByAgentId: 'executor',
        heartbeatCount: 0,
      }),
    );
  });

  it('does not auto-mark in_progress item even when ticket is approved', async () => {
    const inProgressItem = {
      id: 'item-2',
      missionId: MISSION_ID,
      title: 'Build OAuth login support',
      description: 'OAuth2',
      status: 'in_progress',
      heartbeatCount: 1,
      isPhase: false,
      parentId: null,
      sortOrder: 0,
      assignedAgentId: 'sre',
      completedByAgentId: null,
      verifiedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };

    const approvedTicket = {
      id: 'ticket-2',
      title: 'Build OAuth login support',
      executionStatus: 'review_approved',
      executionBranch: 'feat/oauth',
      mergeStatus: null,
      executionReview: null,
    };

    mockGetActiveMissions.mockResolvedValue([baseMission]);
    mockGetMissionItems.mockResolvedValue([inProgressItem] as any);
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([approvedTicket]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));

    await startMissionScheduler();
    await vi.advanceTimersByTimeAsync(46_000);

    // updateMissionItem should NOT have been called with agent_complete
    const agentCompleteCalls = mockUpdateMissionItem.mock.calls.filter(
      (call) => (call[1] as any)?.status === 'agent_complete',
    );
    expect(agentCompleteCalls).toHaveLength(0);
  });
});
