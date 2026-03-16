export class RbacRejectionError extends Error {
  blockedAction: string;
  requiredRole: string;
  plainLanguageMessage: string;

  constructor(blockedAction: string, requiredRole: string) {
    const plainLanguageMessage = `Blocked: Insufficient Privileges. Requires ${requiredRole} role. Contact your workspace administrator.`;
    super(plainLanguageMessage);
    this.name = "RbacRejectionError";
    this.blockedAction = blockedAction;
    this.requiredRole = requiredRole;
    this.plainLanguageMessage = plainLanguageMessage;
  }
}
