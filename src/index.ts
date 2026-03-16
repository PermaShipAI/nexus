import 'dotenv/config';
import { logger } from './logger.js';
import { runMigrations } from './db/index.js';
import { initializeAgents } from './agents/registry.js';
import { startServer } from './server/index.js';
import { startIdleTimer } from './idle/timer.js';
import { startNexusScheduler } from './nexus/scheduler.js';
import { startStalenessChecker } from './staleness/checker.js';
import { startSecurityDigestScheduler } from './security/scheduler.js';
import { startKnowledgeSync } from './knowledge/sync.js';
import { logActivity } from './idle/activity.js';
import { config } from './config.js';
import { usageReporter } from './telemetry/usage-reporter.js';
import { loadAdapters } from './adapters/loader.js';

async function main() {
  logger.info('Starting Agent System...');

  try {
    // 0. Initialize adapters (must happen before any subsystem starts)
    await loadAdapters();

    // 1. Run DB migrations
    await runMigrations();
    logger.info('Database migrations applied');

    // 2. Load agents and sync to DB
    await initializeAgents();

    // 3. Start Webhook server
    await startServer();

    // 4. Start background timers
    logger.info('Starting idle timer...');
    startIdleTimer();
    
    logger.info('Starting Nexus scheduler...');
    await startNexusScheduler();
    
    logger.info('Starting staleness checker...');
    startStalenessChecker();
    
    logger.info('Starting security digest scheduler...');
    startSecurityDigestScheduler();
    
    logger.info('Starting knowledge sync...');
    startKnowledgeSync();
    
    logger.info('Starting usage reporter...');
    usageReporter.start();

    // Log system startup
    const orgId = config.DEFAULT_ORG_ID ?? process.env.PERMASHIP_ORG_ID;
    if (orgId) {
      logger.info({ orgId }, 'Logging system startup activity...');
      await logActivity('system_startup', undefined, undefined, orgId);
    }

    logger.info('Agent system online with 10 agents');
  } catch (err) {
    logger.error({ err }, 'FATAL: Failed to start agent system in main() catch block');
    process.exit(1);
  }
}

main();

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await usageReporter.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await usageReporter.stop();
  process.exit(0);
});
