import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateTaskStatus } from './service.js';

vi.mock('../../agents/telemetry/logger.js', () => ({
  logInvalidStateTransitionBlocked: vi.fn(),
}));

vi.mock('../db/index.js', () => {
  const mockQuery = {
    set: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'task-1', status: 'in_progress' }]),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(mockQuery),
      update: vi.fn().mockReturnValue(mockQuery),
    },
  };
});

import { logInvalidStateTransitionBlocked } from '../../agents/telemetry/logger.js';

describe('updateTaskStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws and logs when status is waiting_for_human', async () => {
    await expect(
      updateTaskStatus('task-1', 'org-1', 'waiting_for_human' as any),
    ).rejects.toThrow(/Blocked/);

    expect(logInvalidStateTransitionBlocked).toHaveBeenCalledWith({
      orgId: 'org-1',
      taskId: 'task-1',
      requestedStatus: 'waiting_for_human',
      agentId: undefined,
    });
  });

  it('throws and logs when status is ci_running', async () => {
    await expect(
      updateTaskStatus('task-1', 'org-1', 'ci_running' as any),
    ).rejects.toThrow(/Blocked/);

    expect(logInvalidStateTransitionBlocked).toHaveBeenCalledWith({
      orgId: 'org-1',
      taskId: 'task-1',
      requestedStatus: 'ci_running',
      agentId: undefined,
    });
  });

  it('does not throw for in_progress (happy path)', async () => {
    await expect(
      updateTaskStatus('task-1', 'org-1', 'in_progress'),
    ).resolves.not.toThrow();

    expect(logInvalidStateTransitionBlocked).not.toHaveBeenCalled();
  });
});
