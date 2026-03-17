import type { UsageSink } from './interfaces/usage-sink.js';
import type { CommitProvider } from './interfaces/commit-provider.js';
import type { KnowledgeSource } from './interfaces/knowledge-source.js';
import type { CommunicationAdapter } from './interfaces/communication-adapter.js';
import type { ProjectRegistry } from './interfaces/project-registry.js';
import type { TicketTracker } from './interfaces/ticket-tracker.js';
import type { TenantResolver } from './interfaces/tenant-resolver.js';
import type { LLMProvider } from './interfaces/llm-provider.js';

export interface AdapterSet {
  usageSink: UsageSink;
  commitProvider: CommitProvider;
  knowledgeSource: KnowledgeSource;
  communicationAdapter: CommunicationAdapter;
  projectRegistry: ProjectRegistry;
  ticketTracker: TicketTracker;
  tenantResolver: TenantResolver;
  llmProvider: LLMProvider;
}

let adapters: AdapterSet | null = null;

function get(): AdapterSet {
  if (!adapters) {
    throw new Error('Adapters not initialized — call initAdapters() before accessing adapters');
  }
  return adapters;
}

export function initAdapters(set: AdapterSet): void {
  adapters = set;
}

export function getUsageSink(): UsageSink {
  return get().usageSink;
}

export function getCommitProvider(): CommitProvider {
  return get().commitProvider;
}

export function getKnowledgeSource(): KnowledgeSource {
  return get().knowledgeSource;
}

export function getCommunicationAdapter(): CommunicationAdapter {
  return get().communicationAdapter;
}

export function getProjectRegistry(): ProjectRegistry {
  return get().projectRegistry;
}

export function getTicketTracker(): TicketTracker {
  return get().ticketTracker;
}

export function getTenantResolver(): TenantResolver {
  return get().tenantResolver;
}

export function getLLMProvider(): LLMProvider {
  return get().llmProvider;
}

/** Hot-swap the ticket tracker at runtime (used when executor backend changes) */
export function setTicketTracker(tracker: TicketTracker): void {
  get().ticketTracker = tracker;
}

/** Hot-swap the LLM provider at runtime (used by setup flow) */
export function setLLMProvider(provider: LLMProvider): void {
  get().llmProvider = provider;
}
