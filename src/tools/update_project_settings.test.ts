import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../settings/service.js', () => ({
  getSetting: vi.fn().mockResolvedValue(undefined),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Must import AFTER vi.mock
import { updateProjectSettings } from './update_project_settings.js';
import { getSetting, setSetting } from '../settings/service.js';
import { logger } from '../logger.js';

const mockGetSetting = vi.mocked(getSetting);
const mockSetSetting = vi.mocked(setSetting);
const mockLoggerInfo = vi.mocked(logger.info);
const mockLoggerWarn = vi.mocked(logger.warn);

const baseInput = {
  orgId: 'org-123',
  project_id: 'proj-456',
  agentId: 'nexus' as const,
};

describe('updateProjectSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('invalid setting_key', () => {
    it('returns { success: false } for an unknown key', async () => {
      const result = await updateProjectSettings({
        ...baseInput,
        setting_key: 'arbitrary_unknown_key',
        value: true,
      });

      expect(result.success).toBe(false);
    });

    it('message mentions allowed keys when key is invalid', async () => {
      const result = await updateProjectSettings({
        ...baseInput,
        setting_key: 'arbitrary_unknown_key',
        value: true,
      });

      expect(result.message).toMatch(/autonomous_mode/);
      expect(result.message).toMatch(/approval_policy/);
    });

    it('does NOT call setSetting for an unknown key', async () => {
      await updateProjectSettings({
        ...baseInput,
        setting_key: 'arbitrary_unknown_key',
        value: true,
      });

      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it('calls logger.warn with event agent.tool.settings_update and success:false for invalid key', async () => {
      await updateProjectSettings({
        ...baseInput,
        setting_key: 'arbitrary_unknown_key',
        value: true,
      });

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.settings_update',
          success: false,
        }),
        expect.any(String),
      );
    });
  });

  describe('missing confirmation_token for sensitive setting', () => {
    it('returns { success: false } when confirmation_token is absent', async () => {
      const result = await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
      });

      expect(result.success).toBe(false);
    });

    it('returns { success: false } when confirmation_token is an empty string', async () => {
      const result = await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
        confirmation_token: '',
      });

      expect(result.success).toBe(false);
    });

    it('returns { success: false } when confirmation_token is whitespace only', async () => {
      const result = await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
        confirmation_token: '   ',
      });

      expect(result.success).toBe(false);
    });

    it('message mentions confirmation_token when token is missing', async () => {
      const result = await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
      });

      expect(result.message).toMatch(/confirmation_token/i);
    });

    it('does NOT call setSetting when confirmation_token is missing', async () => {
      await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
      });

      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it('calls logger.warn with event agent.tool.settings_update and success:false for missing token', async () => {
      await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
      });

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.settings_update',
          success: false,
        }),
        expect.any(String),
      );
    });
  });

  describe('successful update', () => {
    it('returns { success: true } with valid inputs', async () => {
      mockGetSetting.mockResolvedValue(false);

      const result = await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
        confirmation_token: 'token-abc',
      });

      expect(result.success).toBe(true);
    });

    it('calls setSetting with correct arguments', async () => {
      mockGetSetting.mockResolvedValue(false);

      await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
        confirmation_token: 'token-abc',
      });

      expect(mockSetSetting).toHaveBeenCalledWith(
        'autonomous_mode',
        true,
        'org-123',
        'nexus',
      );
    });

    it('returns previous_value and new_value on success', async () => {
      mockGetSetting.mockResolvedValue(false);

      const result = await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
        confirmation_token: 'token-abc',
      });

      expect(result.previous_value).toBe(false);
      expect(result.new_value).toBe(true);
    });

    it('calls logger.info with event agent.tool.settings_update and success:true on success', async () => {
      mockGetSetting.mockResolvedValue(false);

      await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
        confirmation_token: 'token-abc',
      });

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.settings_update',
          success: true,
        }),
        expect.any(String),
      );
    });

    it('works for approval_policy setting with confirmation_token', async () => {
      mockGetSetting.mockResolvedValue('manual');

      const result = await updateProjectSettings({
        ...baseInput,
        setting_key: 'approval_policy',
        value: 'auto',
        confirmation_token: 'token-xyz',
      });

      expect(result.success).toBe(true);
      expect(mockSetSetting).toHaveBeenCalledWith(
        'approval_policy',
        'auto',
        'org-123',
        'nexus',
      );
    });
  });

  describe('telemetry logging', () => {
    it('logger.warn is called with success:false on invalid key', async () => {
      await updateProjectSettings({
        ...baseInput,
        setting_key: 'totally_invalid',
        value: 'any',
      });

      const warnCalls = mockLoggerWarn.mock.calls;
      const matchingCall = warnCalls.find(
        ([obj]) => typeof obj === 'object' && obj !== null && 'event' in obj && obj.event === 'agent.tool.settings_update',
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![0]).toMatchObject({ success: false });
    });

    it('logger.warn is called with success:false on missing confirmation_token', async () => {
      await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: true,
        // no confirmation_token
      });

      const warnCalls = mockLoggerWarn.mock.calls;
      const matchingCall = warnCalls.find(
        ([obj]) => typeof obj === 'object' && obj !== null && 'event' in obj && obj.event === 'agent.tool.settings_update',
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![0]).toMatchObject({ success: false });
    });

    it('logger.info is called with success:true on successful update', async () => {
      mockGetSetting.mockResolvedValue(null);

      await updateProjectSettings({
        ...baseInput,
        setting_key: 'autonomous_mode',
        value: false,
        confirmation_token: 'valid-token',
      });

      const infoCalls = mockLoggerInfo.mock.calls;
      const matchingCall = infoCalls.find(
        ([obj]) => typeof obj === 'object' && obj !== null && 'event' in obj && obj.event === 'agent.tool.settings_update',
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![0]).toMatchObject({ success: true });
    });
  });
});
