import { describe, it, expect } from 'vitest';
import { ALLOWED_SETTING_KEYS, isAllowedSettingKey } from './allowlist.js';

describe('ALLOWED_SETTING_KEYS', () => {
  it('contains exactly autonomous_mode and public_channels', () => {
    expect(ALLOWED_SETTING_KEYS).toEqual(['autonomous_mode', 'public_channels']);
  });
});

describe('isAllowedSettingKey', () => {
  it('returns true for autonomous_mode', () => {
    expect(isAllowedSettingKey('autonomous_mode')).toBe(true);
  });

  it('returns true for public_channels', () => {
    expect(isAllowedSettingKey('public_channels')).toBe(true);
  });

  it('returns false for db_password', () => {
    expect(isAllowedSettingKey('db_password')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isAllowedSettingKey('')).toBe(false);
  });

  it('returns false for arbitrary unknown key', () => {
    expect(isAllowedSettingKey('api_secret_key')).toBe(false);
  });
});
