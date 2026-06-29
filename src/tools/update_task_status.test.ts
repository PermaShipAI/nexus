import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../tasks/service.js', () => ({
  getTaskById: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

vi.mock('../../agents/telemetry/logger.js', () => ({
  logToolRejectionEvent: vi.fn(),
}));

// Must import AFTER vi.mock
import { updateTaskStatusTool } from './update_task_status.js';
import { getTaskById, updateTaskStatus } from '../tasks/service.js';
import { logToolRejectionEvent } from '../../agents/telemetry/logger.js';

const mockGetTaskById = vi.mocked(getTaskById);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockLogToolRejectionEvent = vi.mocked(logToolRejectionEvent);

describe('updateTaskStatusTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Task not found', () => {
    it('returns { success: false } when task does not exist', async () => {
      mockGetTaskById.mockResolvedValue(null);

      const result = await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task999',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(result.success).toBe(false);
    });

    it('returns error "Task not found" when task does not exist', async () => {
      mockGetTaskById.mockResolvedValue(null);

      const result = await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task999',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(result.error).toBe('Task not found');
    });

    it('does NOT call updateTaskStatus when task is not found', async () => {
      mockGetTaskById.mockResolvedValue(null);

      await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task999',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    });
  });

  describe('Proposed state rejection', () => {
    it('returns { success: false } when task is in proposed state', async () => {
      mockGetTaskById.mockResolvedValue({ id: 'task1', status: 'proposed', orgId: 'org1' } as any);

      const result = await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task1',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(result.success).toBe(false);
    });

    it('returns error "State Transition Rejected" for proposed task', async () => {
      mockGetTaskById.mockResolvedValue({ id: 'task1', status: 'proposed', orgId: 'org1' } as any);

      const result = await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task1',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(result.error).toBe('State Transition Rejected');
    });

    it('returns remediation_instruction containing "You MUST" for proposed task', async () => {
      mockGetTaskById.mockResolvedValue({ id: 'task1', status: 'proposed', orgId: 'org1' } as any);

      const result = await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task1',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(result.remediation_instruction).toBeDefined();
      expect(result.remediation_instruction).toContain('You MUST');
    });

    it('does NOT call updateTaskStatus when task is in proposed state', async () => {
      mockGetTaskById.mockResolvedValue({ id: 'task1', status: 'proposed', orgId: 'org1' } as any);

      await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task1',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    });

    it('calls logToolRejectionEvent once with event tool_state_rejection details', async () => {
      mockGetTaskById.mockResolvedValue({ id: 'task1', status: 'proposed', orgId: 'org1' } as any);

      await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task1',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(mockLogToolRejectionEvent).toHaveBeenCalledTimes(1);
      expect(mockLogToolRejectionEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent1',
          taskId: 'task1',
          currentStatus: 'proposed',
          attemptedStatus: 'in_progress',
        }),
      );
    });
  });

  describe('Valid transition (approved → in_progress)', () => {
    it('returns { success: true } for a valid transition', async () => {
      mockGetTaskById.mockResolvedValue({ id: 'task2', status: 'approved', orgId: 'org1' } as any);
      mockUpdateTaskStatus.mockResolvedValue({ id: 'task2', status: 'in_progress', orgId: 'org1' } as any);

      const result = await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task2',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(result.success).toBe(true);
    });

    it('calls updateTaskStatus with the correct arguments', async () => {
      mockGetTaskById.mockResolvedValue({ id: 'task2', status: 'approved', orgId: 'org1' } as any);
      mockUpdateTaskStatus.mockResolvedValue({ id: 'task2', status: 'in_progress', orgId: 'org1' } as any);

      await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task2',
        newStatus: 'in_progress',
        agentId: 'agent1',
      });

      expect(mockUpdateTaskStatus).toHaveBeenCalledWith('task2', 'org1', 'in_progress', 'agent1');
    });
  });

  describe('Telemetry — logToolRejectionEvent not called on success', () => {
    it('does NOT call logToolRejectionEvent for a valid transition', async () => {
      mockGetTaskById.mockResolvedValue({ id: 'task3', status: 'approved', orgId: 'org1' } as any);
      mockUpdateTaskStatus.mockResolvedValue({ id: 'task3', status: 'completed', orgId: 'org1' } as any);

      await updateTaskStatusTool({
        orgId: 'org1',
        taskId: 'task3',
        newStatus: 'completed',
        agentId: 'agent1',
      });

      expect(mockLogToolRejectionEvent).not.toHaveBeenCalled();
    });
  });
});
