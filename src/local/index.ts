import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { logger } from '../logger.js';
import { db, runMigrations, closeDb } from '../db/index.js';
import { restoreFromBackup, startBackupScheduler, stopBackupScheduler } from '../db/backup.js';
import { workspaceLinks } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { initAdapters } from '../adapters/registry.js';
import { initializeAgents } from '../agents/registry.js';
import { startNexusScheduler } from '../nexus/scheduler.js';
import { startKnowledgeSync } from '../knowledge/sync.js';
import { usageReporter } from '../telemetry/usage-reporter.js';
import { config } from '../config.js';

// Local adapters
import { LocalCommunicationAdapter } from './communication-adapter.js';
import { SingleTenantResolver, LOCAL_ORG_ID, LOCAL_WORKSPACE_ID, LOCAL_CHANNEL_ID } from './tenant-resolver.js';
import { LocalTicketTracker } from './ticket-tracker.js';
import { LocalExecutingTicketTracker } from './executing-ticket-tracker.js';
import { createExecutionBackend } from './execution-backends/factory.js';
import { LocalProjectRegistry } from './project-registry.js';
import { LocalGitCommitProvider } from './commit-provider.js';
import { LocalFileKnowledgeSource } from './knowledge-source.js';

// LLM provider factory (supports Gemini, Anthropic, OpenAI, Ollama, OpenRouter)
import { createLLMProvider } from '../adapters/providers/factory.js';
import { PlaceholderLLMProvider } from './placeholder-llm.js';

import { startLocalServer } from './server.js';

// ── Startup health checks ───────────────────────────────────────────────────

function checkNodeVersion(): void {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    console.error(`Error: Node.js 20+ is required (you have ${process.versions.node}).`);
    console.error('  Install the latest LTS: https://nodejs.org/');
    process.exit(1);
  }
}

/** Returns true if an LLM API key is configured */
function hasLLMKey(): boolean {
  if (config.LLM_PROVIDER === 'ollama') return true;
  return !!(process.env.LLM_API_KEY || process.env.GEMINI_API_KEY);
}

function checkEnvVars(): void {
  if (!hasLLMKey()) {
    console.log('  Note: No LLM API key configured. The UI will show setup instructions.');
  }
}

async function checkDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    // Using embedded PGlite — no connectivity check needed
    console.log('  Database: embedded (PGlite)');
    return;
  }

  console.log('  Database: PostgreSQL');
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('ECONNREFUSED') || msg.includes('connection refused')) {
      console.error('Error: Cannot connect to PostgreSQL.');
      console.error('  Start it with:  docker compose up -d');
      console.error(`  DATABASE_URL:   ${process.env.DATABASE_URL}`);
    } else if (msg.includes('does not exist')) {
      console.error('Error: Database does not exist.');
      console.error('  The docker-compose setup creates a database named "nexus".');
      console.error('  Make sure DATABASE_URL ends with /nexus');
      console.error(`  Current value:  ${process.env.DATABASE_URL}`);
    } else if (msg.includes('password authentication failed')) {
      console.error('Error: PostgreSQL authentication failed.');
      console.error('  Check the username/password in DATABASE_URL match docker-compose.yml.');
    } else {
      console.error(`Error: PostgreSQL connection failed: ${msg}`);
    }
    process.exit(1);
  }
}

function checkGitAvailable(): void {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    console.warn('Warning: git is not installed. Commit history and remote repo cloning will not work.');
    console.warn('  Install git: https://git-scm.com/downloads');
  }
}

// ── Local workspace bootstrapping ───────────────────────────────────────────

/** No-op usage sink for local mode (no remote usage reporting) */
class ConsoleUsageSink {
  async reportUsage(_orgId: string, _payload: any): Promise<void> {}
}

async function ensureLocalWorkspace(): Promise<void> {
  const [existing] = await db
    .select()
    .from(workspaceLinks)
    .where(
      and(
        eq(workspaceLinks.platform, 'discord'),
        eq(workspaceLinks.workspaceId, LOCAL_WORKSPACE_ID),
      ),
    )
    .limit(1);

  if (!existing) {
    await db.insert(workspaceLinks).values({
      orgId: LOCAL_ORG_ID,
      orgName: 'Local',
      platform: 'discord',
      workspaceId: LOCAL_WORKSPACE_ID,
      activatedBy: 'local-setup',
      internalChannelId: LOCAL_CHANNEL_ID,
    });
    logger.info('Local workspace link created');
  }

  // Ensure the current repository is registered as a project
  const { localProjects } = await import('../db/schema.js');
  const [project] = await db
    .select()
    .from(localProjects)
    .where(and(eq(localProjects.orgId, LOCAL_ORG_ID), eq(localProjects.slug, 'nexus')))
    .limit(1);

  if (!project) {
    await db.insert(localProjects).values({
      orgId: LOCAL_ORG_ID,
      name: 'Nexus',
      slug: 'nexus',
      sourceType: 'local',
      localPath: process.cwd(),
      repoKey: 'nexus',
      cloneStatus: 'ready',
    });
    logger.info('Default Nexus project created');
  }
}


// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting Nexus Command in local UI mode...');

  // Pre-flight checks
  checkNodeVersion();
  checkEnvVars();
  checkGitAvailable();
  await checkDatabase();

  try {
    // Build real local adapters
    const projectRegistry = new LocalProjectRegistry();
    const commitProvider = new LocalGitCommitProvider(projectRegistry);
    const knowledgeSource = new LocalFileKnowledgeSource(projectRegistry);

    // Build ticket tracker — with execution backend if configured
    const backendName = config.EXECUTION_BACKEND;
    let ticketTracker;
    if (backendName !== 'noop') {
      const backend = createExecutionBackend();
      const execTracker = new LocalExecutingTicketTracker(backend, config.REPO_ROOT ?? '.');
      execTracker.recoverZombieTickets().catch(err => logger.error({ err }, 'Zombie ticket recovery failed'));
      ticketTracker = execTracker;
      console.log(`  Execution backend: ${backend.name} (repo root: ${config.REPO_ROOT})`);
    } else {
      ticketTracker = new LocalTicketTracker();
    }

    const needsSetup = !hasLLMKey();
    const llmProvider = needsSetup ? new PlaceholderLLMProvider() : createLLMProvider();
    console.log(`  LLM provider: ${needsSetup ? 'not configured (setup required)' : config.LLM_PROVIDER}`);

    // Initialize adapters with local implementations
    initAdapters({
      usageSink: new ConsoleUsageSink(),
      commitProvider,
      knowledgeSource,
      communicationAdapter: new LocalCommunicationAdapter(),
      projectRegistry,
      ticketTracker,
      tenantResolver: new SingleTenantResolver(),
      llmProvider,
    });

    // Run DB migrations
    await runMigrations();
    logger.info('Database migrations applied');

    // Restore from backup if database was reset (e.g., PGlite corruption recovery)
    const restored = await restoreFromBackup();
    if (restored) logger.info('Database restored from backup');

    // Ensure local workspace exists
    await ensureLocalWorkspace();

    // Load agents
    const agents = await initializeAgents();
    console.log(`  Agents loaded: ${agents.length}`);

    // Start Nexus scheduler (so proposals get reviewed)
    await startNexusScheduler();

    // Start mission scheduler (heartbeats for active missions)
    const { startMissionScheduler } = await import('../missions/scheduler.js');
    await startMissionScheduler();

    // Start idle timer (proactive agent analysis on heartbeat)
    const { startIdleTimer } = await import('../idle/timer.js');
    startIdleTimer();

    // Start knowledge sync (reads README/docs from connected projects)
    startKnowledgeSync();

    // Start AgentOps evaluation scheduler (aggregates human rejections weekly)
    const { startAgentOpsEvaluationScheduler } = await import('../agentops/scheduler.js');
    startAgentOpsEvaluationScheduler();

    // Start the local UI server
    const port = parseInt(process.env.LOCAL_UI_PORT ?? '3000', 10);
    await startLocalServer(port);

    // Start usage reporter (noop in local mode but keeps the system happy)
    usageReporter.start();

    // Start periodic database backups (protects against PGlite corruption data loss)
    startBackupScheduler();

    logger.info('Local Nexus Command online');
  } catch (err) {
    logger.error({ err }, 'Failed to start local Nexus Command');
    console.error('\nStartup failed:', (err as Error).message);
    console.error('  See QUICKSTART.md for setup instructions.');
    process.exit(1);
  }
}

main();

async function gracefulShutdown() {
  logger.info('Shutting down...');
  await stopBackupScheduler(); // Final backup before exit
  await usageReporter.stop();
  await closeDb();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
