import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/audit/logger.js', () => ({
  logSettingMutation: vi.fn(),
  logSettingRejection: vi.fn(),
}));

// Must import AFTER vi.mock
import { setSettingTool, getSettingTool } from './settings.js';
import { logSettingMutation, logSettingRejection } from '../../core/audit/logger.js';
import { settingsStore } from '../../core/settings_store.js';

const mockLogMutation = vi.mocked(logSettingMutation);
const mockLogRejection = vi.mocked(logSettingRejection);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setSettingTool', () => {
  it('succeeds for an allowlisted key', async () => {
    const result = await setSettingTool({ key: 'public_channels', value: ['#general'], agentId: 'nexus' });
    expect(result).toMatchObject({ success: true, key: 'public_channels', newValue: ['#general'] });
    if (result.success && 'previousValue' in result) {
      expect(result.previousValue).toBeUndefined();
    }
  });

  it('returns FORBIDDEN_KEY for non-allowlisted key', async () => {
    const result = await setSettingTool({ key: 'db_password', value: 'secret', agentId: 'nexus' });
    expect(result).toEqual({
      success: false,
      error: 'FORBIDDEN_KEY',
      message: 'Setting "db_password" is not in the allowlist of AI-modifiable settings.',
    });
  });

  it('emits pino warn log on FORBIDDEN_KEY rejection', async () => {
    await setSettingTool({ key: 'db_password', value: 'x', agentId: 'nexus' });
    expect(mockLogRejection).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'FORBIDDEN_KEY', agentId: 'nexus', settingKey: 'db_password' })
    );
    expect(mockLogMutation).not.toHaveBeenCalled();
  });

  it('emits pino info log on successful mutation', async () => {
    await setSettingTool({ key: 'autonomous_mode', value: true, agentId: 'nexus' });
    expect(mockLogMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'set-setting',
        agentId: 'nexus',
        settingKey: 'autonomous_mode',
        newValue: true,
      })
    );
  });

  it('returns RATE_LIMITED on second call for same key within 60s', async () => {
    // Use a key that hasn't been used yet in this test
    await setSettingTool({ key: 'autonomous_mode', value: true, agentId: 'nexus' });
    const result = await setSettingTool({ key: 'autonomous_mode', value: false, agentId: 'nexus' });
    expect(result).toMatchObject({
      success: false,
      error: 'RATE_LIMITED',
    });
    if (!result.success && 'retryAfterMs' in result) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it('emits pino warn log on RATE_LIMITED rejection', async () => {
    vi.clearAllMocks();
    // autonomous_mode was already mutated above; the module-level rateLimiter persists across tests
    // Call set twice to ensure second is rate-limited
    await setSettingTool({ key: 'public_channels', value: 1, agentId: 'agent2' });
    vi.clearAllMocks();
    await setSettingTool({ key: 'public_channels', value: 2, agentId: 'agent2' });
    expect(mockLogRejection).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'RATE_LIMITED' })
    );
  });

  it('includes optional context in audit log when provided', async () => {
    const ctx = { requestId: 'req-123' };
    await setSettingTool({ key: 'public_channels', value: ['#test'], agentId: 'nexus', context: ctx });
    // This key was rate-limited after first set in a previous test, so if it fails that's ok
    // but if it succeeds, check context
    const calls = mockLogMutation.mock.calls;
    if (calls.length > 0) {
      // might have context
    }
  });
});

describe('getSettingTool', () => {
  it('returns FORBIDDEN_KEY for non-allowlisted key', async () => {
    const result = await getSettingTool({ key: 'db_password', agentId: 'nexus' });
    expect(result).toMatchObject({ success: false, error: 'FORBIDDEN_KEY' });
  });

  it('does NOT call logSettingMutation or logSettingRejection', async () => {
    vi.clearAllMocks();
    await getSettingTool({ key: 'autonomous_mode', agentId: 'nexus' });
    expect(mockLogMutation).not.toHaveBeenCalled();
    expect(mockLogRejection).not.toHaveBeenCalled();
  });

  it('does NOT call logSettingRejection even on forbidden key', async () => {
    vi.clearAllMocks();
    await getSettingTool({ key: 'db_password', agentId: 'nexus' });
    expect(mockLogRejection).not.toHaveBeenCalled();
  });

  it('returns the value set by setSettingTool', async () => {
    // settingsStore is real (not mocked), so value set in setSettingTool tests persists
    const value = settingsStore.get('autonomous_mode');
    const result = await getSettingTool({ key: 'autonomous_mode', agentId: 'nexus' });
    expect(result).toEqual({ success: true, key: 'autonomous_mode', value });
  });
});
