import { eq, and, lte, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { logger } from '../logger.js';
import {
  missions,
  missionItems,
  missionProjects,
  localProjects,
  type Mission,
  type MissionItem,
  type LocalProject,
} from '../db/schema.js';

export async function createMission(input: {
  orgId: string;
  title: string;
  description: string;
  projectIds?: string[];
  heartbeatIntervalMs?: number;
  cronExpression?: string;
  autonomousMode?: boolean | null;
}): Promise<Mission> {
  const id = crypto.randomUUID();
  const channelId = `mission:${id}`;

  const [mission] = await db
    .insert(missions)
    .values({
      id,
      orgId: input.orgId,
      channelId,
      title: input.title,
      description: input.description,
      heartbeatIntervalMs: input.heartbeatIntervalMs ?? 600_000,
      cronExpression: input.cronExpression ?? null,
      autonomousMode: input.autonomousMode ?? null,
    })
    .returning();

  if (input.projectIds && input.projectIds.length > 0) {
    await db.insert(missionProjects).values(
      input.projectIds.map((projectId) => ({
        missionId: mission.id,
        projectId,
      })),
    );
  }

  return mission;
}

export async function getMission(id: string, orgId: string): Promise<Mission | null> {
  const [mission] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.id, id), eq(missions.orgId, orgId)))
    .limit(1);
  return mission ?? null;
}

export async function getMissionById(id: string): Promise<Mission | null> {
  const [mission] = await db
    .select()
    .from(missions)
    .where(eq(missions.id, id))
    .limit(1);
  return mission ?? null;
}

export async function getMissionByChannelId(channelId: string): Promise<Mission | null> {
  const [mission] = await db
    .select()
    .from(missions)
    .where(eq(missions.channelId, channelId))
    .limit(1);
  return mission ?? null;
}

export async function listMissions(orgId: string, statusFilter?: string): Promise<Mission[]> {
  const conditions = [eq(missions.orgId, orgId)];
  if (statusFilter) {
    conditions.push(eq(missions.status, statusFilter as Mission['status']));
  }
  return db
    .select()
    .from(missions)
    .where(and(...conditions))
    .orderBy(missions.createdAt);
}

export async function updateMissionStatus(
  id: string,
  orgId: string,
  status: Mission['status'],
): Promise<Mission | null> {
  const updates: Partial<Record<string, unknown>> = {
    status,
    updatedAt: new Date(),
  };
  if (status === 'completed') updates.completedAt = new Date();
  if (status === 'cancelled') updates.cancelledAt = new Date();

  const [mission] = await db
    .update(missions)
    .set(updates as any)
    .where(and(eq(missions.id, id), eq(missions.orgId, orgId)))
    .returning();
  return mission ?? null;
}

export async function getMissionItems(missionId: string): Promise<MissionItem[]> {
  return db
    .select()
    .from(missionItems)
    .where(eq(missionItems.missionId, missionId))
    .orderBy(missionItems.sortOrder);
}

export async function addMissionItems(
  missionId: string,
  items: Array<{ title: string; description: string; assignedAgentId?: string }>,
): Promise<MissionItem[]> {
  if (items.length === 0) return [];

  // Dedup: skip items that already exist for this mission (by title)
  const existing = await db.select({ title: missionItems.title })
    .from(missionItems)
    .where(eq(missionItems.missionId, missionId));
  const existingTitles = new Set(existing.map(e => e.title));
  const newItems = items.filter(i => !existingTitles.has(i.title));

  if (newItems.length === 0) return [];

  const values = newItems.map((item, i) => ({
    missionId,
    title: item.title,
    description: item.description,
    assignedAgentId: item.assignedAgentId ?? null,
    sortOrder: existing.length + i,
  }));
  return db.insert(missionItems).values(values).returning();
}

/** Remove duplicate mission items (keeps the oldest by createdAt for each title) */
export async function dedupMissionItems(missionId: string): Promise<number> {
  const items = await db.select().from(missionItems)
    .where(eq(missionItems.missionId, missionId))
    .orderBy(missionItems.createdAt);

  const seen = new Map<string, string>(); // title → id to keep
  const toDelete: string[] = [];

  for (const item of items) {
    if (seen.has(item.title)) {
      toDelete.push(item.id);
    } else {
      seen.set(item.title, item.id);
    }
  }

  if (toDelete.length > 0) {
    await db.delete(missionItems).where(inArray(missionItems.id, toDelete));
  }
  return toDelete.length;
}

export async function getMissionItem(itemId: string): Promise<MissionItem | null> {
  const [item] = await db
    .select()
    .from(missionItems)
    .where(eq(missionItems.id, itemId))
    .limit(1);
  return item ?? null;
}

export async function updateMissionItem(
  itemId: string,
  updates: Partial<Pick<MissionItem, 'status' | 'assignedAgentId' | 'completedByAgentId' | 'verifiedAt' | 'heartbeatCount'>>,
): Promise<MissionItem | null> {
  // Filter out undefined values so we don't overwrite fields with null
  const cleanUpdates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) cleanUpdates[k] = v;
  }
  const [item] = await db
    .update(missionItems)
    .set(cleanUpdates)
    .where(eq(missionItems.id, itemId))
    .returning();
  if (cleanUpdates.heartbeatCount !== undefined) {
    logger.info({ itemId, heartbeatCount: cleanUpdates.heartbeatCount, returnedHb: item?.heartbeatCount }, 'updateMissionItem: heartbeat count update');
  }
  return item ?? null;
}

export async function getMissionProjects(missionId: string): Promise<LocalProject[]> {
  const links = await db
    .select({ projectId: missionProjects.projectId })
    .from(missionProjects)
    .where(eq(missionProjects.missionId, missionId));

  if (links.length === 0) return [];

  return db
    .select()
    .from(localProjects)
    .where(inArray(localProjects.id, links.map((l) => l.projectId)));
}

export async function getActiveMissionsDueForHeartbeat(): Promise<Mission[]> {
  return db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.status, 'active'),
        lte(missions.nextHeartbeatAt, new Date()),
      ),
    );
}

export async function recordHeartbeat(missionId: string, nextHeartbeatAt: Date): Promise<void> {
  await db
    .update(missions)
    .set({
      lastHeartbeatAt: new Date(),
      nextHeartbeatAt,
      updatedAt: new Date(),
    })
    .where(eq(missions.id, missionId));
}
