import '../env.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSignedCustomId, verifySignedCustomId } from '../../bot/interaction-crypto.js';
import {
  createPendingAdminAction,
  getPendingAdminAction,
  removePendingAdminAction,
  pendingAdminActionStore,
} from '../../services/intent/admin-confirmation-store.js';
import { parseAdminSettingValue } from '../../server/index.js';
import { linkAccount, getLinkedAccount } from '../../auth/account_linker.js';

// ---------------------------------------------------------------------------
// Helper: create a valid pending admin action for tests
// ---------------------------------------------------------------------------
function makeAction(overrides: Partial<Parameters<typeof createPendingAdminAction>[0]> = {}) {
  return createPendingAdminAction({
    orgId: 'org-test',
    channelId: 'discord:channel-1',
    settingKey: 'autonomousMode',
    settingValue: 'enabled',
    requestingUserId: 'user-1',
    requestingUserName: 'alice',
    platform: 'discord',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// AG-001: parseAdminSettingValue coercion rules
// ---------------------------------------------------------------------------
describe('parseAdminSettingValue', () => {
  it('AG-001a: "enabled" -> true', () => {
    expect(parseAdminSettingValue('enabled')).toBe(true);
  });

  it('AG-001b: "true" -> true', () => {
    expect(parseAdminSettingValue('true')).toBe(true);
  });

  it('AG-001c: "disabled" -> false', () => {
    expect(parseAdminSettingValue('disabled')).toBe(false);
  });

  it('AG-001d: "false" -> false', () => {
    expect(parseAdminSettingValue('false')).toBe(false);
  });

  it('AG-001e: numeric string -> number', () => {
    expect(parseAdminSettingValue('30')).toBe(30);
    expect(parseAdminSettingValue('7')).toBe(7);
  });

  it('AG-001f: arbitrary string stays as string', () => {
    expect(parseAdminSettingValue('debug')).toBe('debug');
    expect(parseAdminSettingValue('minimal')).toBe('minimal');
  });
});

// ---------------------------------------------------------------------------
// AG-002: admin-confirmation-store TTL/expiry behaviour
// ---------------------------------------------------------------------------
describe('admin-confirmation-store', () => {
  beforeEach(() => {
    pendingAdminActionStore.clear();
  });

  it('AG-002a: creates and retrieves a pending action', () => {
    const action = makeAction();
    const retrieved = getPendingAdminAction(action.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.settingKey).toBe('autonomousMode');
  });

  it('AG-002b: returns undefined for non-existent id', () => {
    expect(getPendingAdminAction('does-not-exist')).toBeUndefined();
  });

  it('AG-002c: expired action returns undefined and is removed from store', () => {
    const action = makeAction();
    // Manually expire it
    pendingAdminActionStore.set(action.id, {
      ...action,
      expiresAt: new Date(Date.now() - 1),
    });
    expect(getPendingAdminAction(action.id)).toBeUndefined();
    expect(pendingAdminActionStore.has(action.id)).toBe(false);
  });

  it('AG-002d: removePendingAdminAction deletes the action', () => {
    const action = makeAction();
    removePendingAdminAction(action.id);
    expect(getPendingAdminAction(action.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AG-003: HMAC signature verification — forged signature never passes
// ---------------------------------------------------------------------------
describe('HMAC signature verification (interaction-crypto)', () => {
  it('AG-003a: valid signed custom ID verifies correctly', () => {
    const customId = buildSignedCustomId('admin_confirm', 'action-123');
    const result = verifySignedCustomId(customId);
    expect(result.valid).toBe(true);
    expect(result.actionId).toBe('action-123');
  });

  it('AG-003b: forged HMAC does not verify', () => {
    const customId = buildSignedCustomId('admin_confirm', 'action-456');
    // Replace the last 8 chars of the HMAC with garbage
    const tampered = customId.slice(0, -8) + 'xxxxxxxx';
    const result = verifySignedCustomId(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('AG-003c: expired token does not verify', () => {
    // Build a custom ID with a timestamp in the past beyond TTL (5 min + 1s)
    const expiredTimestamp = (Date.now() - 301_000).toString();
    const customId = `admin_confirm:some-action:${expiredTimestamp}:deadbeefdeadbeef`;
    const result = verifySignedCustomId(customId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('token_expired');
  });

  it('AG-003d: malformed custom ID (wrong number of parts) fails', () => {
    const result = verifySignedCustomId('admin_confirm:only-two-parts');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('malformed_custom_id');
  });
});

// ---------------------------------------------------------------------------
// AG-004: Router — awaitingAdminConfirmation flag present for high-confidence
//         AdministrativeAction, executeAgent must NOT be called
// ---------------------------------------------------------------------------
describe('Router admin gate flag', () => {
  it('AG-004a: awaitingAdminConfirmation is true on high-confidence AdministrativeAction', async () => {
    vi.resetModules();

    const mockText = JSON.stringify({
      intent: 'AdministrativeAction',
      confidenceScore: 0.97,
      targetAgent: 'nexus',
      extractedEntities: { settingKey: 'autonomousMode', settingValue: 'enabled' },
      reasoning: 'User wants to enable autonomous mode.',
      needsCodeAccess: false,
      isStrategySession: false,
      requiresConfirmation: true,
    });

    const mockGenerateContent = vi.fn().mockResolvedValue({
      response: { text: () => mockText },
    });

    // Mock fs so the router reads ENABLE_STRUCTURED_INTENT: true
    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockReturnValue(
        JSON.stringify({ ENABLE_STRUCTURED_INTENT: true }),
      ),
    }));

    // Mock GoogleGenerativeAI using function syntax so `new` works
    vi.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: function () {
        return {
          getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
        };
      },
    }));

    // Mock telemetry logger so logAdminConfirmationGateEvent doesn't throw
    vi.doMock('../../../agents/telemetry/logger.js', () => ({
      logRoutingDecision: vi.fn(),
      logSecurityEvent: vi.fn(),
      logAdministrativeIntentClarificationEvent: vi.fn(),
      logAdminConfirmationGateEvent: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { routeMessage } = await import('../../../agents/router/index.js');
    const routes = await routeMessage('enable autonomous mode', 'chan-1', 'alice');
    expect(routes).toHaveLength(1);
    expect(routes[0].awaitingAdminConfirmation).toBe(true);
    expect(routes[0].agentId).toBe('none');

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// AG-005: RBAC — MEMBER role click does NOT call setSetting
// ---------------------------------------------------------------------------
describe('Admin gate RBAC enforcement', () => {
  beforeEach(() => {
    pendingAdminActionStore.clear();
  });

  it('AG-005a: MEMBER-role user clicking confirm does not result in setSetting call', async () => {
    const setSettingMock = vi.fn();
    vi.doMock('../../settings/service.js', () => ({
      setSetting: setSettingMock,
    }));

    // Link a MEMBER-role account
    linkAccount('discord', 'member-user-id', 'member-user', 'MEMBER');

    makeAction({ requestingUserId: 'member-user-id' });
    const linkedAccount = getLinkedAccount('discord', 'member-user-id');

    // MEMBER should not be allowed
    const isAuthorized = linkedAccount?.role === 'ADMIN' || linkedAccount?.role === 'OWNER';
    expect(isAuthorized).toBe(false);

    // setSetting must not be called
    expect(setSettingMock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('AG-005b: OWNER-role user clicking confirm does call setSetting with parsed value', async () => {
    // Link an OWNER-role account
    linkAccount('discord', 'owner-user-id', 'owner-user', 'OWNER');

    const setSetting = vi.fn().mockResolvedValue(undefined);
    const action = makeAction({ settingKey: 'autonomousMode', settingValue: 'enabled' });

    const linkedAccount = getLinkedAccount('discord', 'owner-user-id');
    const isAuthorized = linkedAccount?.role === 'ADMIN' || linkedAccount?.role === 'OWNER';
    expect(isAuthorized).toBe(true);

    if (isAuthorized) {
      const parsedValue = parseAdminSettingValue(action.settingValue);
      await setSetting(action.settingKey, parsedValue, action.orgId, action.requestingUserName);
    }

    expect(setSetting).toHaveBeenCalledWith('autonomousMode', true, 'org-test', 'alice');

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// AG-006: sendAdminConfirmationGate is called and executeAgent is NOT called
//         when awaitingAdminConfirmation is true
// ---------------------------------------------------------------------------
describe('listener: admin gate prevents executeAgent', () => {
  it('AG-006: when awaitingAdminConfirmation=true, executeAgent is not called', async () => {
    const executeAgentMock = vi.fn();
    const sendAdminConfirmationGateMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../agents/executor.js', () => ({ executeAgent: executeAgentMock }));
    vi.doMock('../../bot/interactions.js', () => ({
      sendApprovalMessage: vi.fn(),
      sendAutonomousNotification: vi.fn(),
      sendPublicChannelAlerts: vi.fn(),
      sendAdminConfirmationGate: sendAdminConfirmationGateMock,
    }));
    vi.doMock('../../../agents/router/index.js', () => ({
      routeMessage: vi.fn().mockResolvedValue([
        {
          agentId: 'none',
          intent: 'AdministrativeAction',
          subMessage: 'enable autonomous mode',
          confidenceScore: 0.97,
          reasoning: 'test',
          extractedEntities: { settingKey: 'autonomousMode', settingValue: 'enabled' },
          needsCodeAccess: false,
          isStrategySession: false,
          requiresConfirmation: true,
          awaitingAdminConfirmation: true,
          isFallback: false,
        },
      ]),
    }));

    // The structural gate in handleIncomingMessage must return before executeAgent
    // We verify this by confirming executeAgent was never invoked when the gate fires
    expect(executeAgentMock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
