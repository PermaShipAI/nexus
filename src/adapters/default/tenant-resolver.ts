import { db } from '../../db/index.js';
import { workspaceLinks } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import type { TenantResolver, WorkspaceContext } from '../interfaces/tenant-resolver.js';

/**
 * Single-tenant resolver for standalone use.
 * Uses the local database for workspace links without external API calls.
 * No activation token verification — workspaces are linked directly.
 */
export class SingleTenantResolver implements TenantResolver {
  private defaultOrgId: string;
  private defaultOrgName: string;
  private prompted = new Set<string>();

  constructor(defaultOrgId: string, defaultOrgName = 'Default Organization') {
    this.defaultOrgId = defaultOrgId;
    this.defaultOrgName = defaultOrgName;
  }

  async getContext(
    platform: 'discord' | 'slack',
    workspaceId: string,
  ): Promise<WorkspaceContext | null> {
    const [link] = await db
      .select()
      .from(workspaceLinks)
      .where(
        and(
          eq(workspaceLinks.platform, platform),
          eq(workspaceLinks.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!link) return null;
    return {
      orgId: link.orgId,
      orgName: link.orgName ?? this.defaultOrgName,
      platform,
      workspaceId,
      internalChannelId: link.internalChannelId ?? undefined,
    };
  }

  async linkWorkspace(
    orgId: string,
    platform: 'discord' | 'slack',
    workspaceId: string,
    activatedBy: string,
    _channelId: string,
    orgName?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await db.insert(workspaceLinks).values({
        orgId,
        orgName: orgName ?? this.defaultOrgName,
        platform,
        workspaceId,
        activatedBy,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async setInternalChannel(
    platform: 'discord' | 'slack',
    workspaceId: string,
    channelId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await db
        .update(workspaceLinks)
        .set({ internalChannelId: channelId })
        .where(
          and(
            eq(workspaceLinks.platform, platform),
            eq(workspaceLinks.workspaceId, workspaceId),
          ),
        );
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async getOrgName(_orgId: string): Promise<string> {
    return this.defaultOrgName;
  }

  async activateWorkspace(
    _token: string,
    platform: 'discord' | 'slack',
    workspaceId: string,
    activatedBy: string,
    channelId: string,
  ): Promise<{ success: boolean; orgId?: string; orgName?: string; error?: string }> {
    // Single-tenant mode: link directly to the default org without token verification
    const result = await this.linkWorkspace(
      this.defaultOrgId,
      platform,
      workspaceId,
      activatedBy,
      channelId,
      this.defaultOrgName,
    );
    if (result.success) {
      return { success: true, orgId: this.defaultOrgId, orgName: this.defaultOrgName };
    }
    return { success: false, error: result.error };
  }

  shouldPrompt(
    platform: 'discord' | 'slack',
    workspaceId: string,
    _channelId: string,
  ): boolean {
    const key = `${platform}:${workspaceId}`;
    if (this.prompted.has(key)) return false;
    this.prompted.add(key);
    return true;
  }
}
