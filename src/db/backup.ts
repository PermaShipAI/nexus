import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './index.js';
import {
  agents,
  workspaceLinks,
  localProjects,
  pendingActions,
  knowledgeEntries,
  botSettings,
  tickets,
  conversationHistory,
  missions,
  missionItems,
  missionProjects,
  missionAgents,
  tasks,
  secrets,
} from './schema.js';
import { logger } from '../logger.js';

const BACKUP_DIR = join(process.cwd(), 'data');
const BACKUP_FILE = join(BACKUP_DIR, 'nexus-backup.json');
const BACKUP_INTERVAL_MS = 2 * 60 * 1000; // Every 2 minutes

let backupTimer: NodeJS.Timeout | null = null;

interface BackupData {
  version: 1;
  timestamp: string;
  tables: {
    agents: unknown[];
    workspaceLinks: unknown[];
    localProjects: unknown[];
    pendingActions: unknown[];
    knowledgeEntries: unknown[];
    botSettings: unknown[];
    tickets: unknown[];
    conversationHistory: unknown[];
    missions: unknown[];
    missionItems: unknown[];
    missionProjects: unknown[];
    missionAgents: unknown[];
    tasks: unknown[];
    secrets: unknown[];
  };
}

/** Export all critical tables to a JSON backup file */
export async function createBackup(): Promise<void> {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });

    const data: BackupData = {
      version: 1,
      timestamp: new Date().toISOString(),
      tables: {
        agents: await db.select().from(agents),
        workspaceLinks: await db.select().from(workspaceLinks),
        localProjects: await db.select().from(localProjects),
        pendingActions: await db.select().from(pendingActions),
        knowledgeEntries: await db.select().from(knowledgeEntries),
        botSettings: await db.select().from(botSettings),
        tickets: await db.select().from(tickets),
        conversationHistory: await db.select().from(conversationHistory).limit(500),
        missions: await db.select().from(missions),
        missionItems: await db.select().from(missionItems),
        missionProjects: await db.select().from(missionProjects),
        missionAgents: await db.select().from(missionAgents),
        tasks: await db.select().from(tasks),
        secrets: await db.select().from(secrets),
      },
    };

    writeFileSync(BACKUP_FILE, JSON.stringify(data), 'utf-8');
    logger.debug({ file: BACKUP_FILE }, 'Database backup created');
  } catch (err) {
    logger.warn({ err }, 'Failed to create database backup');
  }
}

/** Restore from backup if database is empty (fresh init after corruption) */
export async function restoreFromBackup(): Promise<boolean> {
  if (!existsSync(BACKUP_FILE)) return false;

  // Check if DB already has data (don't overwrite existing data)
  const [existingLink] = await db.select().from(workspaceLinks).limit(1);
  if (existingLink) return false; // DB has data, skip restore

  try {
    const raw = readFileSync(BACKUP_FILE, 'utf-8');
    const data = JSON.parse(raw) as BackupData;

    if (data.version !== 1) {
      logger.warn({ version: data.version }, 'Unknown backup version, skipping restore');
      return false;
    }

    logger.info({ timestamp: data.timestamp }, 'Restoring database from backup');
    console.log(`\n  Restoring data from backup (${data.timestamp})...\n`);

    // Restore in dependency order
    const restoreTable = async (table: any, rows: any[], name: string) => {
      if (!rows || rows.length === 0) return;
      try {
        // Convert date strings back to Date objects
        const processed = rows.map(row => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
              out[k] = new Date(v);
            } else {
              out[k] = v;
            }
          }
          return out;
        });
        await db.insert(table).values(processed).onConflictDoNothing();
        logger.info({ table: name, count: rows.length }, 'Restored table from backup');
      } catch (err) {
        logger.warn({ err, table: name }, 'Failed to restore table (non-fatal)');
      }
    };

    await restoreTable(workspaceLinks, data.tables.workspaceLinks, 'workspaceLinks');
    await restoreTable(agents, data.tables.agents, 'agents');
    await restoreTable(localProjects, data.tables.localProjects, 'localProjects');
    await restoreTable(botSettings, data.tables.botSettings, 'botSettings');
    await restoreTable(knowledgeEntries, data.tables.knowledgeEntries, 'knowledgeEntries');
    await restoreTable(secrets, data.tables.secrets, 'secrets');
    await restoreTable(tasks, data.tables.tasks, 'tasks');
    await restoreTable(missions, data.tables.missions, 'missions');
    await restoreTable(missionItems, data.tables.missionItems, 'missionItems');
    await restoreTable(missionProjects, data.tables.missionProjects, 'missionProjects');
    await restoreTable(missionAgents, data.tables.missionAgents ?? [], 'missionAgents');
    await restoreTable(pendingActions, data.tables.pendingActions, 'pendingActions');
    await restoreTable(tickets, data.tables.tickets, 'tickets');
    await restoreTable(conversationHistory, data.tables.conversationHistory, 'conversationHistory');

    console.log('  Data restored successfully.\n');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to restore from backup');
    return false;
  }
}

/** Start periodic backup timer */
export function startBackupScheduler(): void {
  // Initial backup after 30s (let system stabilize)
  setTimeout(() => {
    createBackup().catch(() => {});
  }, 30_000);

  backupTimer = setInterval(() => {
    createBackup().catch(() => {});
  }, BACKUP_INTERVAL_MS);

  logger.info({ intervalMs: BACKUP_INTERVAL_MS }, 'Database backup scheduler started');
}

/** Stop backup scheduler and create a final backup */
export async function stopBackupScheduler(): Promise<void> {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
  await createBackup();
}
