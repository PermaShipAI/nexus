export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

/** @deprecated Use `Role` instead. */
export type PermaShipRole = Role;

export interface RequestContext {
  platformUserId: string;
  platform: 'discord' | 'slack';
  channelType: 'public' | 'private' | 'dm';
  /** Previously named `permashipRole`. */
  role?: Role;
  messageId: string;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: 'AccountNotLinked' | 'InsufficientRole' | 'PublicChannelRestriction' | 'FeatureDisabled';
  requiredRole?: Role;
  userMessage?: string;
}
