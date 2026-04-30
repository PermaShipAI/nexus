import { ClassifiedIntent } from '../../agents/schemas/intent.js';

// Lookup table for INTENT_MOCK_MODE=true
// Maps exact message strings to pre-defined ClassifiedIntent objects
export const MOCK_INTENT_MAP: Record<string, ClassifiedIntent> = {
  'investigate the login bug': {
    kind: 'InvestigateBug',
    confidenceScore: 0.95,
    params: { subject: 'login bug' },
  },
  'propose a task for the onboarding flow': {
    kind: 'ProposeTask',
    confidenceScore: 0.92,
    params: { subject: 'onboarding flow' },
  },
  'what is the status of the system': {
    kind: 'SystemStatus',
    confidenceScore: 0.97,
    params: {},
  },
  'delete the staging project': {
    kind: 'ManageProject',
    confidenceScore: 0.94,
    params: { deleteTarget: 'staging project' },
  },
  'get the database password': {
    kind: 'AccessSecrets',
    confidenceScore: 0.96,
    params: { secretName: 'database password' },
  },
  'what does this project do': {
    kind: 'QueryKnowledge',
    confidenceScore: 0.91,
    params: { subject: 'project purpose' },
  },
  'manage the alpha project': {
    kind: 'ManageProject',
    confidenceScore: 0.93,
    params: { target: 'alpha project' },
  },
  'low confidence message xyz123': {
    kind: 'Unknown',
    confidenceScore: 0.3,
    params: {},
  },
  'enable autonomous mode': {
    kind: 'AdministrativeAction',
    confidenceScore: 0.92,
    params: { settingKey: 'autonomous_mode', settingValue: 'true' },
  },
  'maybe do the admin thing': {
    kind: 'AdministrativeAction',
    confidenceScore: 0.70,
    params: {},
  },
};

export function getMockIntent(message: string): ClassifiedIntent | null {
  return MOCK_INTENT_MAP[message.toLowerCase()] ?? null;
}
