import { describe, it, expect } from 'vitest';
import { validateSettingKey } from './settings_validator.js';

describe('validateSettingKey', () => {
  it('returns valid:true for autonomous_mode', () => {
    expect(validateSettingKey('autonomous_mode')).toEqual({ valid: true });
  });

  it('returns valid:true for public_channels', () => {
    expect(validateSettingKey('public_channels')).toEqual({ valid: true });
  });

  it('returns FORBIDDEN_KEY for unknown key', () => {
    const result = validateSettingKey('db_password');
    expect(result).toEqual({
      valid: false,
      error: 'FORBIDDEN_KEY',
      message: 'Setting "db_password" is not in the allowlist of AI-modifiable settings.',
    });
  });

  it('returns FORBIDDEN_KEY for empty string', () => {
    const result = validateSettingKey('');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('FORBIDDEN_KEY');
    }
  });
});
