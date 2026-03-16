export const ALLOWED_SETTING_KEYS = ['autonomous_mode', 'public_channels'] as const;

export type AllowedSettingKey = typeof ALLOWED_SETTING_KEYS[number];

export function isAllowedSettingKey(key: string): key is AllowedSettingKey {
  return (ALLOWED_SETTING_KEYS as readonly string[]).includes(key);
}
