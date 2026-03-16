import { initAdapters, type AdapterSet } from './registry.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Loads and initializes the adapter set based on ADAPTER_PROFILE env var.
 *
 * - "permaship" — PermaShip production adapters (requires PERMASHIP_* env vars)
 * - "default" (or unset) — Standalone OSS adapters (local DB, console output, file-based config)
 */
export async function loadAdapters(): Promise<void> {
  const profile = process.env.ADAPTER_PROFILE ?? 'default';

  let adapters: AdapterSet;

  if (profile === 'permaship') {
    adapters = await loadPermashipAdapters();
    logger.info('Loaded PermaShip adapter profile');
  } else {
    adapters = await loadDefaultAdapters();
    logger.info('Loaded default (OSS) adapter profile');
  }

  initAdapters(adapters);
}

async function loadPermashipAdapters(): Promise<AdapterSet> {
  // Dynamic imports to avoid loading PermaShip deps when using default profile
  const { PermashipUsageSink } = await import('./permaship/usage-sink.js');
  const { PermashipCommitProvider } = await import('./permaship/commit-provider.js');
  const { PermashipKnowledgeSource } = await import('./permaship/knowledge-source.js');
  const { PermashipCommunicationAdapter } = await import('./permaship/communication-adapter.js');
  const { PermashipProjectRegistry } = await import('./permaship/project-registry.js');
  const { PermashipTicketTracker } = await import('./permaship/ticket-tracker.js');
  const { PermashipTenantResolver } = await import('./permaship/tenant-resolver.js');
  const { GeminiLLMProvider } = await import('./permaship/llm-provider.js');

  return {
    usageSink: new PermashipUsageSink(),
    commitProvider: new PermashipCommitProvider(),
    knowledgeSource: new PermashipKnowledgeSource(),
    communicationAdapter: new PermashipCommunicationAdapter(),
    projectRegistry: new PermashipProjectRegistry(),
    ticketTracker: new PermashipTicketTracker(),
    tenantResolver: new PermashipTenantResolver(),
    llmProvider: new GeminiLLMProvider(),
  };
}

async function loadDefaultAdapters(): Promise<AdapterSet> {
  const { DefaultLLMProvider } = await import('./default/llm-provider.js');
  const { ConsoleCommunicationAdapter } = await import('./default/communication-adapter.js');
  const { LocalProjectRegistry } = await import('./default/project-registry.js');
  const { LocalTicketTracker } = await import('./default/ticket-tracker.js');
  const { GitCommitProvider } = await import('./default/commit-provider.js');
  const { FileKnowledgeSource } = await import('./default/knowledge-source.js');
  const { SingleTenantResolver } = await import('./default/tenant-resolver.js');
  const { ConsoleUsageSink } = await import('./default/usage-sink.js');

  return {
    usageSink: new ConsoleUsageSink(),
    commitProvider: new GitCommitProvider(),
    knowledgeSource: new FileKnowledgeSource(),
    communicationAdapter: new ConsoleCommunicationAdapter(),
    projectRegistry: new LocalProjectRegistry(),
    ticketTracker: new LocalTicketTracker(),
    tenantResolver: new SingleTenantResolver(
      config.DEFAULT_ORG_ID ?? '00000000-0000-0000-0000-000000000000',
      config.DEFAULT_ORG_NAME ?? 'Default Organization',
    ),
    llmProvider: new DefaultLLMProvider(config.LLM_API_KEY ?? ''),
  };
}
