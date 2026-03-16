import { getSetting, setSetting } from '../settings/service.js';
import { logger } from '../logger.js';
import type { AgentId } from '../agents/types.js';
import { MODIFIABLE_SETTINGS, MODIFIABLE_SETTING_KEYS } from '../settings/constants.js';

export interface UpdateProjectSettingsInput {
  orgId: string;
  project_id: string;
  setting_key: string;
  value: unknown;
  confirmation_token?: string;
  agentId: AgentId;
}

export interface UpdateProjectSettingsResult {
  success: boolean;
  message: string;
  previous_value?: unknown;
  new_value?: unknown;
}

export async function updateProjectSettings(
  input: UpdateProjectSettingsInput,
): Promise<UpdateProjectSettingsResult> {
  const { orgId, project_id, setting_key, value, confirmation_token, agentId } = input;

  // Validation 1: Check setting_key is in MODIFIABLE_SETTING_KEYS
  if (!MODIFIABLE_SETTING_KEYS.has(setting_key)) {
    const allowed = MODIFIABLE_SETTINGS.map(s => s.key).join(', ');
    logger.warn(
      {
        event: 'agent.tool.settings_update',
        agentId,
        orgId,
        project_id,
        setting_key,
        success: false,
        reason: 'invalid_key',
      },
      'Settings update rejected: invalid key',
    );
    return {
      success: false,
      message: `Setting key ${setting_key} is not modifiable. Allowed keys: ${allowed}`,
    };
  }

  // Validation 2: If setting is sensitive and confirmation_token is absent/empty
  const settingDef = MODIFIABLE_SETTINGS.find(s => s.key === setting_key)!;
  if (settingDef.sensitive && (!confirmation_token || confirmation_token.trim() === '')) {
    logger.warn(
      {
        event: 'agent.tool.settings_update',
        agentId,
        orgId,
        project_id,
        setting_key,
        success: false,
        reason: 'missing_confirmation_token',
      },
      'Settings update rejected: missing confirmation token',
    );
    return {
      success: false,
      message: 'A confirmation_token from the UI gate is required for sensitive settings',
    };
  }

  // Read previous value
  const previous_value = await getSetting(setting_key, orgId);

  // Write new value
  await setSetting(setting_key, value, orgId, agentId);

  logger.info(
    {
      event: 'agent.tool.settings_update',
      agentId,
      orgId,
      project_id,
      setting_key,
      success: true,
      previous_value,
      new_value: value,
    },
    'Settings update succeeded',
  );

  return {
    success: true,
    message: `Setting "${setting_key}" updated successfully`,
    previous_value,
    new_value: value,
  };
}
