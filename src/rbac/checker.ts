import { ClassifiedIntent } from '../../agents/schemas/intent.js';
import { RequestContext, PermissionResult } from './types.js';
import { PERMISSION_MAP, hasMinimumRole } from './permission_map.js';

export function checkPermission(
  intent: ClassifiedIntent,
  context: RequestContext,
): PermissionResult {
  const requiredRole = PERMISSION_MAP[intent.kind];

  // Unknown intents and read-only intents can be accessed without linking
  if (intent.kind === 'Unknown') {
    return { allowed: true };
  }

  // Account not linked — block anything beyond VIEWER-level
  if (!context.role) {
    const viewerIntents = ['QueryKnowledge', 'SystemStatus'];
    if (!viewerIntents.includes(intent.kind)) {
      return {
        allowed: false,
        reason: 'AccountNotLinked',
        userMessage:
          'You need to link your account to use this feature. Use the link command to get started.',
      };
    }
    return { allowed: true };
  }

  if (!hasMinimumRole(context.role, requiredRole)) {
    return {
      allowed: false,
      reason: 'InsufficientRole',
      requiredRole,
      userMessage: `This action requires the ${requiredRole} role or higher. Contact a workspace Owner or Admin to request access.`,
    };
  }

  return { allowed: true };
}
