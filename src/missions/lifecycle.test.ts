import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./service.js', () => ({
  getMission: vi.fn(),
  getMissionItems: vi.fn(),
  getMissionProjects: vi.fn(),
  getMissionPhaseProgress: vi.fn(),
  updateMissionStatus: vi.fn(),
  addMissionItems: vi.fn(),
  addMissionPhases: vi.fn(),
  setMissionRoster: vi.fn(),
  recordHeartbeat: vi.fn(),
  dedupMissionItems: vi.fn().mockResolvedValue(0),
}));

vi.mock('../agents/executor.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { planMission, checkMissionCompletion } from './lifecycle.js';
import {
  getMission,
  getMissionPhaseProgress,
  getMissionProjects,
  updateMissionStatus,
  addMissionPhases,
  recordHeartbeat,
} from './service.js';
import { executeAgent } from '../agents/executor.js';

const mockGetMission = getMission as ReturnType<typeof vi.fn>;
const mockGetMissionPhaseProgress = getMissionPhaseProgress as ReturnType<typeof vi.fn>;
const mockGetMissionProjects = getMissionProjects as ReturnType<typeof vi.fn>;
const mockUpdateMissionStatus = updateMissionStatus as ReturnType<typeof vi.fn>;
const mockAddMissionPhases = addMissionPhases as ReturnType<typeof vi.fn>;
const mockRecordHeartbeat = recordHeartbeat as ReturnType<typeof vi.fn>;
const mockExecuteAgent = executeAgent as ReturnType<typeof vi.fn>;

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const MISSION_ID = '00000000-0000-0000-0000-000000000002';

const baseMission = {
  id: MISSION_ID,
  orgId: ORG_ID,
  channelId: `mission:${MISSION_ID}`,
  title: 'Build a new feature',
  description: 'Add authentication to the app',
  heartbeatIntervalMs: 600_000,
};

describe('planMission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMissionStatus.mockResolvedValue({});
    mockAddMissionPhases.mockResolvedValue([]);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockGetMissionProjects.mockResolvedValue([]);
  });

  it('throws when mission does not exist', async () => {
    mockGetMission.mockResolvedValue(null);

    await expect(planMission(MISSION_ID, ORG_ID)).rejects.toThrow(
      `Mission ${MISSION_ID} not found`,
    );
    expect(mockUpdateMissionStatus).not.toHaveBeenCalled();
  });

  it('throws for invalid state transition from active — does not persist', async () => {
    mockGetMission.mockResolvedValue({ ...baseMission, status: 'active' });

    await expect(planMission(MISSION_ID, ORG_ID)).rejects.toThrow(
      /Cannot plan mission.*invalid state transition from 'active'/,
    );
    expect(mockUpdateMissionStatus).not.toHaveBeenCalled();
  });

  it('throws for invalid state transition from completed — does not persist', async () => {
    mockGetMission.mockResolvedValue({ ...baseMission, status: 'completed' });

    await expect(planMission(MISSION_ID, ORG_ID)).rejects.toThrow(
      /Cannot plan mission.*invalid state transition from 'completed'/,
    );
    expect(mockUpdateMissionStatus).not.toHaveBeenCalled();
  });

  it('throws for invalid state transition from cancelled — does not persist', async () => {
    mockGetMission.mockResolvedValue({ ...baseMission, status: 'cancelled' });

    await expect(planMission(MISSION_ID, ORG_ID)).rejects.toThrow(
      /Cannot plan mission.*invalid state transition from 'cancelled'/,
    );
    expect(mockUpdateMissionStatus).not.toHaveBeenCalled();
  });

  it('throws for invalid state transition from planning — does not persist', async () => {
    mockGetMission.mockResolvedValue({ ...baseMission, status: 'planning' });

    await expect(planMission(MISSION_ID, ORG_ID)).rejects.toThrow(
      /Cannot plan mission.*invalid state transition from 'planning'/,
    );
    expect(mockUpdateMissionStatus).not.toHaveBeenCalled();
  });

  it('successfully plans a draft mission: draft → planning → active', async () => {
    mockGetMission.mockResolvedValue({ ...baseMission, status: 'draft' });
    mockExecuteAgent.mockResolvedValue(
      '{"phases": [{"title": "Write tests", "description": "Add unit tests for auth"}], "agents": []}',
    );

    await planMission(MISSION_ID, ORG_ID);

    expect(mockUpdateMissionStatus).toHaveBeenCalledWith(MISSION_ID, ORG_ID, 'planning');
    expect(mockUpdateMissionStatus).toHaveBeenCalledWith(MISSION_ID, ORG_ID, 'active');
    expect(mockAddMissionPhases).toHaveBeenCalledWith(MISSION_ID, [
      { title: 'Write tests', description: 'Add unit tests for auth' },
    ]);
    expect(mockRecordHeartbeat).toHaveBeenCalled();
  });

  it('still transitions to active even if agent planning fails', async () => {
    mockGetMission.mockResolvedValue({ ...baseMission, status: 'draft' });
    mockExecuteAgent.mockRejectedValue(new Error('LLM API error'));

    await planMission(MISSION_ID, ORG_ID);

    expect(mockUpdateMissionStatus).toHaveBeenCalledWith(MISSION_ID, ORG_ID, 'planning');
    expect(mockUpdateMissionStatus).toHaveBeenCalledWith(MISSION_ID, ORG_ID, 'active');
    expect(mockAddMissionPhases).not.toHaveBeenCalled();
  });

  it('proceeds without adding items when agent returns no JSON array', async () => {
    mockGetMission.mockResolvedValue({ ...baseMission, status: 'draft' });
    mockExecuteAgent.mockResolvedValue('I could not generate a plan right now.');

    await planMission(MISSION_ID, ORG_ID);

    expect(mockUpdateMissionStatus).toHaveBeenCalledWith(MISSION_ID, ORG_ID, 'active');
    expect(mockAddMissionPhases).not.toHaveBeenCalled();
  });
});

describe('checkMissionCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMissionStatus.mockResolvedValue({});
  });

  it('returns false when no phases exist', async () => {
    mockGetMissionPhaseProgress.mockResolvedValue([]);

    const result = await checkMissionCompletion(MISSION_ID, ORG_ID);

    expect(result).toBe(false);
    expect(mockUpdateMissionStatus).not.toHaveBeenCalled();
  });

  it('returns false when some phases are still in progress', async () => {
    mockGetMissionPhaseProgress.mockResolvedValue([
      { phase: { id: 'phase-1', status: 'verified' }, completedSubSteps: 2, totalSubSteps: 2 },
      { phase: { id: 'phase-2', status: 'in_progress' }, completedSubSteps: 1, totalSubSteps: 3 },
    ]);

    const result = await checkMissionCompletion(MISSION_ID, ORG_ID);

    expect(result).toBe(false);
    expect(mockUpdateMissionStatus).not.toHaveBeenCalled();
  });

  it('transitions to completed when all phases are verified', async () => {
    mockGetMissionPhaseProgress.mockResolvedValue([
      { phase: { id: 'phase-1', status: 'verified' }, completedSubSteps: 2, totalSubSteps: 2 },
      { phase: { id: 'phase-2', status: 'verified' }, completedSubSteps: 3, totalSubSteps: 3 },
    ]);

    const result = await checkMissionCompletion(MISSION_ID, ORG_ID);

    expect(result).toBe(true);
    expect(mockUpdateMissionStatus).toHaveBeenCalledWith(MISSION_ID, ORG_ID, 'completed');
    expect(mockUpdateMissionStatus).toHaveBeenCalledTimes(1);
  });
});
