export interface SettingDefinition {
  key: string;
  sensitive: boolean;
  description: string;
  valueType: 'boolean' | 'string' | 'number';
}

export const MODIFIABLE_SETTINGS: SettingDefinition[] = [
  { key: 'autonomous_mode', sensitive: true, description: 'Toggle autonomous ticket creation', valueType: 'boolean' },
  { key: 'approval_policy', sensitive: true, description: 'Ticket approval policy', valueType: 'string' },
];

export const MODIFIABLE_SETTING_KEYS = new Set(MODIFIABLE_SETTINGS.map(s => s.key));
