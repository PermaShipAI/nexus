import { eq, and, like } from 'drizzle-orm';
import { db } from '../db/index.js';
import { knowledgeEntries, workspaceLinks } from '../db/schema.js';
import { getProjectRegistry } from '../adapters/registry.js';
import { getKnowledgeSource } from '../adapters/registry.js';
import { getLLMProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const SOURCE_PREFIX = 'kb:';

let syncInterval: ReturnType<typeof setInterval> | null = null;

/** Build a sourceId from a dashboard document UUID */
function toSourceId(docId: string): string {
  return `${SOURCE_PREFIX}${docId}`;
}

/** Get all distinct org IDs from workspace links */
async function getAllOrgIds(): Promise<string[]> {
  const links = await db
    .selectDistinct({ orgId: workspaceLinks.orgId })
    .from(workspaceLinks);
  return links.map((l) => l.orgId);
}

/** Sync knowledge base for a single org */
export async function syncKnowledgeBase(orgId: string): Promise<void> {
  logger.info({ orgId }, 'Starting KB sync');

  let projects;
  try {
    projects = await getProjectRegistry().listProjects(orgId);
  } catch (err) {
    logger.error({ err, orgId }, 'KB sync: failed to list projects');
    return;
  }

  const seenSourceIds = new Set<string>();

  for (const project of projects) {
    let documents;
    try {
      documents = await getKnowledgeSource().fetchKnowledgeDocuments(orgId, project.id);
    } catch (err) {
      logger.warn({ err, orgId, projectId: project.id }, 'KB sync: failed to fetch documents for project');
      continue;
    }

    for (const doc of documents) {
      const sourceId = toSourceId(doc.id);
      seenSourceIds.add(sourceId);

      try {
        // Check if entry already exists
        const [existing] = await db
          .select()
          .from(knowledgeEntries)
          .where(
            and(
              eq(knowledgeEntries.sourceId, sourceId),
              eq(knowledgeEntries.orgId, orgId),
            ),
          )
          .limit(1);

        const topic = `[KB:${project.name}] ${doc.title}`;

        if (existing) {
          // Skip if content hasn't changed
          if (existing.content === doc.content) {
            continue;
          }

          // Update existing entry
          const embedding = await getLLMProvider().embedText(`${topic}: ${doc.content}`);
          await db
            .update(knowledgeEntries)
            .set({
              topic,
              content: doc.content,
              embedding,
              updatedAt: new Date(),
            })
            .where(eq(knowledgeEntries.id, existing.id));

          logger.info({ sourceId, topic }, 'KB sync: updated entry');
        } else {
          // Insert new entry
          const embedding = await getLLMProvider().embedText(`${topic}: ${doc.content}`);
          await db.insert(knowledgeEntries).values({
            orgId,
            kind: 'shared',
            topic,
            content: doc.content,
            sourceId,
            embedding,
          });

          logger.info({ sourceId, topic }, 'KB sync: created entry');
        }
      } catch (err) {
        logger.warn({ err, sourceId, docTitle: doc.title }, 'KB sync: failed to upsert document');
      }
    }
  }

  // Delete stale entries whose source doc no longer exists
  try {
    const localEntries = await db
      .select({ id: knowledgeEntries.id, sourceId: knowledgeEntries.sourceId })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.orgId, orgId),
          like(knowledgeEntries.sourceId, `${SOURCE_PREFIX}%`),
        ),
      );

    for (const entry of localEntries) {
      if (entry.sourceId && !seenSourceIds.has(entry.sourceId)) {
        await db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, entry.id));
        logger.info({ sourceId: entry.sourceId }, 'KB sync: removed stale entry');
      }
    }
  } catch (err) {
    logger.warn({ err, orgId }, 'KB sync: failed to clean up stale entries');
  }

  logger.info({ orgId, projectCount: projects.length }, 'KB sync complete');
}

/** Run sync for all linked orgs */
async function runSyncAll(): Promise<void> {
  const orgIds = await getAllOrgIds();
  for (const orgId of orgIds) {
    try {
      await syncKnowledgeBase(orgId);
    } catch (err) {
      logger.error({ err, orgId }, 'KB sync failed for org');
    }
  }
}

/** Start periodic KB sync (runs immediately, then every 15 min) */
export function startKnowledgeSync(): void {
  logger.info('Starting KB sync scheduler (every 15 min)');

  // Run async — don't block startup
  runSyncAll().catch((err) => logger.error({ err }, 'Initial KB sync failed'));

  syncInterval = setInterval(() => {
    runSyncAll().catch((err) => logger.error({ err }, 'Periodic KB sync failed'));
  }, SYNC_INTERVAL_MS);
}

/** Stop periodic KB sync */
export function stopKnowledgeSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    logger.info('KB sync scheduler stopped');
  }
}
