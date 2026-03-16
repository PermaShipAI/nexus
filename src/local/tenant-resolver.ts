import type { TenantResolver, WorkspaceContext } from '../adapters/interfaces/tenant-resolver.js';

export const LOCAL_ORG_ID = '00000000-0000-0000-0000-000000000001';
export const LOCAL_WORKSPACE_ID = 'local';
export const LOCAL_CHANNEL_ID = 'local:general';

export class SingleTenantResolver implements TenantResolver {
  private orgName = 'Local';

  async getContext(
    _platform: 'discord' | 'slack',
    _workspaceId: string,
  ): Promise<WorkspaceContext | null> {
    return {
      orgId: LOCAL_ORG_ID,
      orgName: this.orgName,
      platform: 'discord',
      workspaceId: LOCAL_WORKSPACE_ID,
      internalChannelId: LOCAL_CHANNEL_ID,
    };
  }

  async linkWorkspace(): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  async setInternalChannel(): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  async getOrgName(): Promise<string> {
    return this.orgName;
  }

  async activateWorkspace(): Promise<{ success: boolean; orgId?: string; orgName?: string; error?: string }> {
    return { success: true, orgId: LOCAL_ORG_ID, orgName: this.orgName };
  }

  shouldPrompt(): boolean {
    return false;
  }
}
