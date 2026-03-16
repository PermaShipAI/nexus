import { tenantService, getOrgName as getOrgNameImpl } from '../../services/tenant.js';
import type { TenantResolver, WorkspaceContext } from '../interfaces/tenant-resolver.js';

export class PermashipTenantResolver implements TenantResolver {
  async getContext(
    platform: 'discord' | 'slack',
    workspaceId: string,
  ): Promise<WorkspaceContext | null> {
    return tenantService.getContext(platform, workspaceId);
  }

  async linkWorkspace(
    orgId: string,
    platform: 'discord' | 'slack',
    workspaceId: string,
    activatedBy: string,
    channelId: string,
    orgName?: string,
  ): Promise<{ success: boolean; error?: string }> {
    return tenantService.linkWorkspace(orgId, platform, workspaceId, activatedBy, channelId, orgName);
  }

  async setInternalChannel(
    platform: 'discord' | 'slack',
    workspaceId: string,
    channelId: string,
  ): Promise<{ success: boolean; error?: string }> {
    return tenantService.setInternalChannel(platform, workspaceId, channelId);
  }

  async getOrgName(orgId: string): Promise<string> {
    return getOrgNameImpl(orgId);
  }

  async activateWorkspace(
    token: string,
    platform: 'discord' | 'slack',
    workspaceId: string,
    activatedBy: string,
    channelId: string,
  ): Promise<{ success: boolean; orgId?: string; orgName?: string; error?: string }> {
    return tenantService.activateWorkspace(token, platform, workspaceId, activatedBy, channelId);
  }

  shouldPrompt(
    platform: 'discord' | 'slack',
    workspaceId: string,
    channelId: string,
  ): boolean {
    return tenantService.shouldPrompt(platform, workspaceId, channelId);
  }
}
