import { RbacRejectionError } from "./errors.js";

export function checkPermission(
  userId: string,
  action: string,
  requiredRole: string,
  userRoles: string[]
): void {
  if (!userRoles.includes(requiredRole)) {
    throw new RbacRejectionError(action, requiredRole);
  }
}

const SUPPORT_BLOCKED_COMMANDS = new Set([
  'provision_user',
  'delete_user',
  'grant_role',
  'approve-action',
  'approve-proposal',
  'reject-proposal',
]);

export function checkAgentCommandPermission(agentId: string, command: string): void {
  if (agentId === 'support' && SUPPORT_BLOCKED_COMMANDS.has(command)) {
    throw new RbacRejectionError(command, 'admin');
  }
}
