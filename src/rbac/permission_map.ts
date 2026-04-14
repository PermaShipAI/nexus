import { IntentKind } from '../../agents/schemas/intent.js';
import { Role } from './types.js';

const ROLE_HIERARCHY: Record<Role, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export const PERMISSION_MAP: Record<IntentKind, Role> = {
  QueryKnowledge: 'VIEWER',
  SystemStatus: 'VIEWER',
  InvestigateBug: 'MEMBER',
  ProposeTask: 'MEMBER',
  ManageProject: 'ADMIN',
  AdministrativeAction: 'ADMIN',
  AccessSecrets: 'OWNER',
  DestructiveAction: 'OWNER',
  Unknown: 'VIEWER',
  StrictConsultation: 'VIEWER',
};

export function hasMinimumRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}
