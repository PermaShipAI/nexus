import '../env.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock telemetry before importing modules that use it
vi.mock('../../telemetry/index.js', () => ({
  logGuardrailEvent: vi.fn(),
}));

// Mock the pino logger used by the confirmation store's cleanup interval
vi.mock('../../../agents/telemetry/logger.js', () => ({
  logger: { info: vi.fn() },
}));

import { verifyAdminRole } from '../../middleware/rbac/admin.js';
import {
  createPendingConfirmation,
  pendingConfirmationStore,
} from '../../services/intent/confirmation.js';
import { handleConfirm } from '../../services/intent/confirmation-handler.js';

describe('Security: Identity State Fuzzing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    pendingConfirmationStore.clear();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // IS-001: verifyAdminRole returns false for 'pending' role
  // ---------------------------------------------------------------------------
  it('IS-001: verifyAdminRole returns false for pending role', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'pending' }),
    } as Response);

    expect(await verifyAdminRole('user-pending')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // IS-002: verifyAdminRole returns false for 'shadow' role
  // ---------------------------------------------------------------------------
  it('IS-002: verifyAdminRole returns false for shadow role', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'shadow' }),
    } as Response);

    expect(await verifyAdminRole('user-shadow')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // IS-003: verifyAdminRole returns false for 'unverified' role
  // ---------------------------------------------------------------------------
  it('IS-003: verifyAdminRole returns false for unverified role', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: 'unverified' }),
    } as Response);

    expect(await verifyAdminRole('user-unverified')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // IS-004: verifyAdminRole returns false for null role
  // ---------------------------------------------------------------------------
  it('IS-004: verifyAdminRole returns false for null role', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ role: null }),
    } as Response);

    expect(await verifyAdminRole('user-null-role')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // IS-005: createPendingConfirmation stores the correct userId binding
  // ---------------------------------------------------------------------------
  it('IS-005: createPendingConfirmation stores the correct userId in the store', () => {
    const confirmation = createPendingConfirmation({
      channelId: 'ch-sec-1',
      userId: 'admin-user-123',
      intent: 'ProposeTask',
      extractedEntities: {},
      targetAgent: 'task-agent',
      confirmationPrompt: 'Do you want me to create a new task? [Confirm] [Cancel]',
    });

    const stored = pendingConfirmationStore.get(confirmation.id);
    expect(stored).toBeDefined();
    expect(stored!.userId).toBe('admin-user-123');
  });

  // ---------------------------------------------------------------------------
  // IS-006 (PF-001 remediated): handleConfirm blocks mismatched userId
  // ---------------------------------------------------------------------------
  it('IS-006 (PF-001): handleConfirm blocks mismatched userId', async () => {
    const confirmation = createPendingConfirmation({
      channelId: 'ch-sec-2',
      userId: 'admin-user-456',
      intent: 'ProposeTask',
      extractedEntities: {},
      targetAgent: 'task-agent',
      confirmationPrompt: 'Do you want me to create a new task? [Confirm] [Cancel]',
    });

    const attackerExecutor = vi.fn().mockResolvedValue([]);

    await expect(
      handleConfirm(confirmation.id, attackerExecutor, 'attacker-user-789'),
    ).rejects.toThrow('User identity mismatch');

    expect(attackerExecutor).not.toHaveBeenCalled();
    // Confirmation remains available for the legitimate user
    expect(pendingConfirmationStore.has(confirmation.id)).toBe(true);
  });
});
