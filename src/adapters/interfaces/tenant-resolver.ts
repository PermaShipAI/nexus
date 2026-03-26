export interface WorkspaceContext {
  orgId: string;
  orgName?: string;
  platform: 'discord' | 'slack' | 'github';
  workspaceId: string;
  internalChannelId?: string;
}

export interface TenantResolver {
  getContext(
    platform: 'discord' | 'slack' | 'github',
    workspaceId: string,
  ): Promise<WorkspaceContext | null>;

  linkWorkspace(
    orgId: string,
    platform: 'discord' | 'slack' | 'github',
    workspaceId: string,
    activatedBy: string,
    channelId: string,
    orgName?: string,
  ): Promise<{ success: boolean; error?: string }>;

  setInternalChannel(
    platform: 'discord' | 'slack' | 'github',
    workspaceId: string,
    channelId: string,
  ): Promise<{ success: boolean; error?: string }>;

  getOrgName(orgId: string): Promise<string>;

  activateWorkspace(
    token: string,
    platform: 'discord' | 'slack' | 'github',
    workspaceId: string,
    activatedBy: string,
    channelId: string,
  ): Promise<{ success: boolean; orgId?: string; orgName?: string; error?: string }>;

  shouldPrompt(
    platform: 'discord' | 'slack' | 'github',
    workspaceId: string,
    channelId: string,
  ): boolean;
}
