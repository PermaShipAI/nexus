import { db } from '../db/index.js';
import { workspaceLinks } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../logger.js';
import { verifyActivationToken } from '../permaship/client.js';

export interface WorkspaceContext {
  orgId: string;
  orgName?: string;
  platform: 'discord' | 'slack';
  workspaceId: string;
  internalChannelId?: string;
}

/**
 * Manages multi-tenant organization mapping and activation.
 */
export class TenantService {
  private static instance: TenantService;
  private cache = new Map<string, WorkspaceContext>();
  private lastPromptCache = new Map<string, number>();

  private constructor() {}

  public static getInstance(): TenantService {
    if (!TenantService.instance) {
      TenantService.instance = new TenantService();
    }
    return TenantService.instance;
  }

  /**
   * Get the Org ID for a given Discord/Slack workspace.
   */
  public async getContext(platform: 'discord' | 'slack', workspaceId: string): Promise<WorkspaceContext | null> {
    const cacheKey = `${platform}:${workspaceId}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const [link] = await db
      .select()
      .from(workspaceLinks)
      .where(and(
        eq(workspaceLinks.platform, platform),
        eq(workspaceLinks.workspaceId, workspaceId)
      ))
      .limit(1);

    if (!link) return null;

    const context: WorkspaceContext = {
      orgId: link.orgId,
      orgName: link.orgName || undefined,
      platform: link.platform as 'discord' | 'slack',
      workspaceId: link.workspaceId,
      internalChannelId: link.internalChannelId || undefined,
    };

    this.cache.set(cacheKey, context);
    return context;
  }

  /**
   * Link a workspace to an organization using an activation token.
   * This is called when a user runs !activate <token>
   */
  public async activateWorkspace(
    token: string, 
    platform: 'discord' | 'slack', 
    workspaceId: string,
    activatedBy: string,
    channelId: string
  ): Promise<{ success: boolean; orgId?: string; orgName?: string; error?: string }> {
    logger.info({ platform, workspaceId, channelId }, 'Attempting workspace activation');

    // 1. Verify token with API
    const verification = await verifyActivationToken(token);
    if (!verification.success || !verification.orgId) {
      return { success: false, error: verification.error || 'Invalid activation token' };
    }

    const { orgId, orgName } = verification;

    try {
      // 2. Check if already linked
      const existing = await this.getContext(platform, workspaceId);
      if (existing) {
        return { success: false, error: 'This workspace is already linked to an organization.' };
      }

      await db.insert(workspaceLinks).values({
        orgId,
        orgName: orgName || undefined,
        platform,
        workspaceId,
        activatedBy,
        internalChannelId: channelId,
      });

      this.cache.delete(`${platform}:${workspaceId}`);
      logger.info({ orgId, orgName, platform, workspaceId }, 'Workspace successfully activated');
      
      return { success: true, orgId, orgName };
    } catch (err) {
      logger.error({ err }, 'Activation failed');
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Directly link a workspace to an organization. 
   * Used by the internal API after a successful OAuth or dashboard selection flow.
   */
  public async linkWorkspace(
    orgId: string,
    platform: 'discord' | 'slack',
    workspaceId: string,
    activatedBy: string,
    channelId: string,
    orgName?: string,
  ): Promise<{ success: boolean; error?: string }> {
    logger.info({ orgId, orgName, platform, workspaceId, channelId }, 'Directly linking workspace');

    try {
      // Upsert: update if exists (e.g. re-linking), insert if new
      const existing = await this.getContext(platform, workspaceId);

      if (existing) {
        await db.update(workspaceLinks)
          .set({ orgId, activatedBy, internalChannelId: channelId, ...(orgName ? { orgName } : {}) })
          .where(and(
            eq(workspaceLinks.platform, platform),
            eq(workspaceLinks.workspaceId, workspaceId)
          ));
      } else {
        await db.insert(workspaceLinks).values({
          orgId,
          orgName: orgName || undefined,
          platform,
          workspaceId,
          activatedBy,
          internalChannelId: channelId,
        });
      }

      this.cache.delete(`${platform}:${workspaceId}`);
      return { success: true };
    } catch (err) {
      logger.error({ err }, 'Linking failed');
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Check if we should prompt for activation in an unlinked workspace.
   * Logic: Prompt if it's the first time, or if 24 hours have passed.
   */
  public shouldPrompt(platform: 'discord' | 'slack', workspaceId: string, channelId: string): boolean {
    const cacheKey = `${platform}:${workspaceId}:${channelId}`;
    const lastPrompt = this.lastPromptCache.get(cacheKey);
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    if (!lastPrompt || (now - lastPrompt) > TWENTY_FOUR_HOURS) {
      this.lastPromptCache.set(cacheKey, now);
      return true;
    }
    return false;
  }

  /**
   * Update the internal control channel for an organization.
   */
  public async setInternalChannel(
    platform: 'discord' | 'slack',
    workspaceId: string,
    channelId: string
  ): Promise<{ success: boolean; error?: string }> {
    logger.info({ platform, workspaceId, channelId }, 'Updating internal control channel');

    try {
      await db.update(workspaceLinks)
        .set({ internalChannelId: channelId })
        .where(and(
          eq(workspaceLinks.platform, platform),
          eq(workspaceLinks.workspaceId, workspaceId)
        ));
      
      // Clear specific cache entry
      this.cache.delete(`${platform}:${workspaceId}`);
      return { success: true };
    } catch (err) {
      logger.error({ err }, 'Failed to update internal channel');
      return { success: false, error: (err as Error).message };
    }
  }
}

export const tenantService = TenantService.getInstance();

/**
 * Get the human-readable org name for use in agent identity / prompts.
 * Falls back to 'the team' for legacy rows without an org name.
 */
export async function getOrgName(orgId: string): Promise<string> {
  const [link] = await db
    .select({ orgName: workspaceLinks.orgName })
    .from(workspaceLinks)
    .where(eq(workspaceLinks.orgId, orgId))
    .limit(1);
  return link?.orgName ?? 'the team';
}
