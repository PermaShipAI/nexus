import { db } from '../db/index.js';
import { botSettings, publicChannels, missions, localProjects } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../logger.js';

export async function getSetting(key: string, orgId: string): Promise<unknown | null> {
  const [row] = await db
    .select({ value: botSettings.value })
    .from(botSettings)
    .where(and(eq(botSettings.key, key), eq(botSettings.orgId, orgId)))
    .limit(1);

  return row?.value ?? null;
}

export async function setSetting(
  key: string,
  value: unknown,
  orgId: string,
  updatedBy: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: botSettings.id })
    .from(botSettings)
    .where(and(eq(botSettings.key, key), eq(botSettings.orgId, orgId)))
    .limit(1);

  if (existing) {
    await db
      .update(botSettings)
      .set({ value, updatedBy, updatedAt: new Date() })
      .where(eq(botSettings.id, existing.id));
  } else {
    await db.insert(botSettings).values({ orgId, key, value, updatedBy });
  }

  logger.info({ key, orgId, updatedBy }, 'Bot setting updated');
}

export async function isAutonomousMode(orgId: string): Promise<boolean> {
  const value = await getSetting('autonomous_mode', orgId);
  return value === true;
}

export interface AutonomousContext {
  orgId: string;
  channelId?: string | null;
  repoKey?: string | null;
}

/**
 * Resolve autonomous mode with scoped overrides.
 * Resolution order: Mission > Project > Global org setting > false.
 * NULL at any level means "inherit from next level."
 */
export async function resolveAutonomousMode(ctx: AutonomousContext): Promise<boolean> {
  const { orgId, channelId, repoKey } = ctx;

  // 1. Mission-level override (highest specificity)
  if (channelId && channelId.startsWith('mission:')) {
    const [m] = await db
      .select({ autonomousMode: missions.autonomousMode })
      .from(missions)
      .where(eq(missions.channelId, channelId))
      .limit(1);
    if (m?.autonomousMode !== null && m?.autonomousMode !== undefined) {
      return m.autonomousMode;
    }
  }

  // 2. Project-level override
  if (repoKey) {
    const [p] = await db
      .select({ autonomousMode: localProjects.autonomousMode })
      .from(localProjects)
      .where(and(eq(localProjects.repoKey, repoKey), eq(localProjects.orgId, orgId)))
      .limit(1);
    if (p?.autonomousMode !== null && p?.autonomousMode !== undefined) {
      return p.autonomousMode;
    }
  }

  // 3. Global org-level fallback
  return isAutonomousMode(orgId);
}

export async function getPublicChannels(orgId: string): Promise<{ channelId: string }[]> {
  const rows = await db
    .select({ channelId: publicChannels.channelId })
    .from(publicChannels)
    .where(eq(publicChannels.orgId, orgId));
  return rows;
}

export async function addPublicChannel(
  channelId: string,
  orgId: string,
  updatedBy: string,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(publicChannels)
    .where(and(eq(publicChannels.orgId, orgId), eq(publicChannels.channelId, channelId)))
    .limit(1);

  if (existing) return;

  await db.insert(publicChannels).values({
    orgId,
    channelId,
    registeredBy: updatedBy,
  });
}

export async function removePublicChannel(
  channelId: string,
  orgId: string,
): Promise<void> {
  await db.delete(publicChannels)
    .where(and(eq(publicChannels.orgId, orgId), eq(publicChannels.channelId, channelId)));
}

export async function isPublicChannel(channelId: string): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(publicChannels)
    .where(eq(publicChannels.channelId, channelId))
    .limit(1);
  return !!existing;
}

export async function isNexusReportsEnabled(orgId: string): Promise<boolean> {
  const value = await getSetting('nexus_reports', orgId);
  return value !== false; // defaults to on
}

export async function getModelId(tier: string, orgId: string): Promise<string | null> {
  const value = await getSetting(`model_${tier.toLowerCase()}`, orgId);
  return typeof value === 'string' ? value : null;
}

export async function setModelId(tier: string, modelId: string, orgId: string, updatedBy: string): Promise<void> {
  await setSetting(`model_${tier.toLowerCase()}`, modelId, orgId, updatedBy);
}

