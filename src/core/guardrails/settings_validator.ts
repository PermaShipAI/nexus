import { isAllowedSettingKey } from '../../config/allowlist.js';

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: 'FORBIDDEN_KEY'; message: string };

export function validateSettingKey(key: string): ValidationResult {
  if (isAllowedSettingKey(key)) {
    return { valid: true };
  }
  return {
    valid: false,
    error: 'FORBIDDEN_KEY',
    message: `Setting "${key}" is not in the allowlist of AI-modifiable settings.`,
  };
}
