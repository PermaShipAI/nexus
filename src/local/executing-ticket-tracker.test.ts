import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mock factory can reference these before initialization
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../db/index.js', () => ({ db: mockDb }));

// Build a reusable mock DB chain factory
function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function makeUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    // make the chain itself awaitable
    then: (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject),
  };
  return chain;
}

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./communication-adapter.js', () => ({
  localBus: { emit: vi.fn() },
}));

vi.mock('../agents/executor.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../bot/formatter.js', () => ({
  sendAgentMessage: vi.fn(),
}));

vi.mock('./tenant-resolver.js', () => ({
  LOCAL_ORG_ID: 'local-org',
  LOCAL_CHANNEL_ID: 'local-channel',
}));

vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: vi.fn().mockReturnValue({
    listProjects: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock('../settings/service.js', () => ({
  getSetting: vi.fn().mockResolvedValue(false),
}));

import { LocalExecutingTicketTracker } from './executing-ticket-tracker.js';

const mockBackend = {
  name: 'test-backend',
  execute: vi.fn(),
};

describe('LocalExecutingTicketTracker', () => {
  let tracker: LocalExecutingTicketTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset insert chain for base class createTicket calls
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{
        id: 'new-ticket-id',
        orgId: 'org-1',
        kind: 'task',
        title: 'Test Ticket',
        description: 'desc',
        repoKey: 'repo',
        executionStatus: 'pending',
      }]),
    });
    tracker = new LocalExecutingTicketTracker(mockBackend as any, '/test/repo');
  });

  describe('recoverZombieTickets', () => {
    it('does nothing when no zombie tickets are present', async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));

      await tracker.recoverZombieTickets();

      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('marks each zombie ticket as failed with recovery message', async () => {
      const zombies = [
        { id: 'zombie-1', title: 'Crashed Task A' },
        { id: 'zombie-2', title: 'Crashed Task B' },
      ];
      mockDb.select.mockReturnValue(makeSelectChain(zombies));

      const updateChain = makeUpdateChain();
      mockDb.update.mockReturnValue(updateChain);

      await tracker.recoverZombieTickets();

      // One db.update call per zombie
      expect(mockDb.update).toHaveBeenCalledTimes(2);

      // Each update sets executionStatus to 'failed' with the recovery message
      for (const call of updateChain.set.mock.calls) {
        expect(call[0]).toMatchObject({
          executionStatus: 'failed',
          executionOutput: 'Recovered: execution was interrupted by a process restart.',
        });
        expect(call[0].executedAt).toBeInstanceOf(Date);
      }
    });

    it('does not duplicate recovery: second call with no zombies makes no updates', async () => {
      const zombies = [{ id: 'zombie-1', title: 'Crashed Task' }];
      const updateChain = makeUpdateChain();
      mockDb.update.mockReturnValue(updateChain);

      // First call: one zombie found
      mockDb.select.mockReturnValueOnce(makeSelectChain(zombies));
      await tracker.recoverZombieTickets();
      expect(mockDb.update).toHaveBeenCalledTimes(1);

      // Second call: zombie is now gone (ticket is 'failed', not 'running')
      mockDb.select.mockReturnValueOnce(makeSelectChain([]));
      await tracker.recoverZombieTickets();

      // No additional updates
      expect(mockDb.update).toHaveBeenCalledTimes(1);
    });

    it('handles 50-ticket batch limit without processing extras', async () => {
      // Simulates the .limit(50) — we return exactly 50 zombies
      const zombies = Array.from({ length: 50 }, (_, i) => ({
        id: `zombie-${i}`,
        title: `Crashed Task ${i}`,
      }));
      mockDb.select.mockReturnValue(makeSelectChain(zombies));

      const updateChain = makeUpdateChain();
      mockDb.update.mockReturnValue(updateChain);

      await tracker.recoverZombieTickets();

      expect(mockDb.update).toHaveBeenCalledTimes(50);
    });
  });

  describe('retryExecution', () => {
    it('returns an error when the ticket does not exist', async () => {
      mockDb.select.mockReturnValue(makeSelectChain([]));

      const result = await tracker.retryExecution('nonexistent-id');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Ticket not found');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('returns an error without updating when ticket is already running', async () => {
      const runningTicket = {
        id: 'ticket-1',
        orgId: 'org-1',
        title: 'Running Task',
        description: 'desc',
        kind: 'task',
        repoKey: 'repo',
        executionStatus: 'running',
        createdByAgentId: null,
      };
      mockDb.select.mockReturnValue(makeSelectChain([runningTicket]));

      const result = await tracker.retryExecution('ticket-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution already running');
      // Idempotency: no state mutation
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('resets execution state to running for a failed ticket', async () => {
      const failedTicket = {
        id: 'ticket-1',
        orgId: 'org-1',
        title: 'Failed Task',
        description: 'desc',
        kind: 'task',
        repoKey: 'repo',
        executionStatus: 'failed',
        createdByAgentId: null,
      };
      mockDb.select.mockReturnValue(makeSelectChain([failedTicket]));

      const updateChain = makeUpdateChain();
      mockDb.update.mockReturnValue(updateChain);

      const result = await tracker.retryExecution('ticket-1');

      expect(result.success).toBe(true);
      expect(mockDb.update).toHaveBeenCalled();

      const setArgs = updateChain.set.mock.calls[0][0];
      expect(setArgs.executionStatus).toBe('running');
      expect(setArgs.executionOutput).toBeNull();
      expect(setArgs.executionDiff).toBeNull();
      expect(setArgs.executionReview).toBeNull();
      expect(setArgs.executedAt).toBeNull();
    });

    it('resets execution state to running for a review_failed ticket', async () => {
      const reviewFailedTicket = {
        id: 'ticket-2',
        orgId: 'org-1',
        title: 'Review Failed Task',
        description: 'desc',
        kind: 'feature',
        repoKey: 'repo',
        executionStatus: 'review_failed',
        createdByAgentId: 'qa-manager',
      };
      mockDb.select.mockReturnValue(makeSelectChain([reviewFailedTicket]));

      const updateChain = makeUpdateChain();
      mockDb.update.mockReturnValue(updateChain);

      const result = await tracker.retryExecution('ticket-2');

      expect(result.success).toBe(true);
      const setArgs = updateChain.set.mock.calls[0][0];
      expect(setArgs.executionStatus).toBe('running');
    });
  });
});
