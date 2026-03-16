import { db } from '../db/index.js';
import { permashipTickets } from '../db/schema.js';
import { permashipConfig as config } from '../adapters/permaship/config.js';
import { logger } from '../logger.js';
import type { AgentId } from '../agents/types.js';

export interface CreateTicketInput {
  orgId: string;
  kind: 'bug' | 'feature' | 'task';
  title: string;
  description: string;
  repoKey: string;
  projectId: string;
  priority?: number;
  labels?: string[];
  createdByAgentId: AgentId;
}

export interface CreateSuggestionInput {
  repoKey: string;
  title: string;
  kind: 'bug' | 'feature' | 'task';
  description: string;
  projectId: string;
  priority?: number;
  labels?: string[];
}

interface SuggestionApiResponse {
  suggestion: {
    id: string;
    status: string;
  };
}

/** Build a base URL for the PermaShip API, normalising trailing slashes and versioning */
function getApiBase(): string | null {
  if (!config.PERMASHIP_API_URL) return null;
  return config.PERMASHIP_API_URL.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Build a base URL for the PermaShip v1 API */
function apiUrl(path: string, orgId: string): string {
  const base = getApiBase();
  if (!base) return '';
  return `${base}/api/orgs/${orgId}${path}`;
}

/** Build a base URL for the internal PermaShip API */
function internalApiUrl(path: string, orgId: string): string {
  const base = getApiBase();
  if (!base) return '';
  return `${base}/api/internal/orgs/${orgId}${path}`;
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `ApiKey ${config.PERMASHIP_API_KEY}`,
  };
}

function internalAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.PERMASHIP_INTERNAL_SECRET) {
    headers['X-Internal-Secret'] = config.PERMASHIP_INTERNAL_SECRET;
  }
  return headers;
}

export interface PermashipProject {
  id: string;
  name: string;
  slug: string;
  repoKey?: string | null;
}

/** Simple TTL cache for project lists (per org) */
const projectCache = new Map<string, { projects: PermashipProject[]; expiresAt: number }>();
const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Fetch all projects from the PermaShip API (cached) */
export async function listProjects(orgId: string): Promise<PermashipProject[]> {
  const cached = projectCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.projects;
  }

  const url = internalApiUrl('/projects', orgId);
  if (!url) return cached?.projects ?? [];

  const response = await fetch(url, { headers: internalAuthHeaders() });
  if (!response.ok) {
    logger.error({ status: response.status, url }, 'Failed to list projects');
    return cached?.projects ?? [];
  }
  const data = (await response.json()) as { projects?: PermashipProject[]; data?: PermashipProject[] };
  const projects = data.projects ?? data.data ?? [];

  projectCache.set(orgId, { projects, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
  return projects;
}

/** Resolve a project name/slug to its UUID. Returns undefined if not found. */
export async function resolveProjectId(nameOrSlug: string, orgId: string): Promise<string | undefined> {
  const projects = await listProjects(orgId);

  // 1. Exact match on id, slug, or name (case-insensitive)
  const lower = nameOrSlug.toLowerCase().trim();
  const exact = projects.find(
    p => p.id === nameOrSlug || p.slug.toLowerCase() === lower || p.name.toLowerCase() === lower,
  );
  if (exact) return exact.id;

  // 2. Fuzzy match: check if the input is a substring of a project name/slug or vice versa
  const fuzzy = projects.find(
    p => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase())
      || p.slug.toLowerCase().includes(lower) || lower.includes(p.slug.toLowerCase()),
  );
  if (fuzzy) {
    logger.info({ nameOrSlug, matched: fuzzy.name, matchedId: fuzzy.id }, 'Fuzzy-matched project name');
    return fuzzy.id;
  }

  logger.warn(
    { nameOrSlug, orgId, availableProjects: projects.map(p => `${p.name} (${p.slug})`) },
    'Could not resolve project name/slug to ID',
  );
  return undefined;
}

/** Resolve the default repo key for a project (from the API). Returns undefined if not found. */
export async function resolveRepoKey(projectId: string, orgId: string): Promise<string | undefined> {
  const projects = await listProjects(orgId);
  const project = projects.find(p => p.id === projectId);
  return project?.repoKey ?? undefined;
}

/** Resolve the project slug for use as a fallback repo key. */
export async function resolveProjectSlug(projectId: string, orgId: string): Promise<string | undefined> {
  const projects = await listProjects(orgId);
  const project = projects.find(p => p.id === projectId);
  return project?.slug ?? undefined;
}

/** Create a new ticket suggestion via the internal API */
export async function createSuggestion(
  orgId: string,
  input: CreateSuggestionInput,
): Promise<{ success: boolean; suggestionId?: string; error?: string }> {
  const url = internalApiUrl(`/projects/${input.projectId}/suggestions`, orgId);
  if (!url) return { success: false, error: 'PermaShip integration not configured' };

  logger.info({ title: input.title, projectId: input.projectId, url }, 'Creating PermaShip suggestion');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...internalAuthHeaders(),
        'X-Idempotency-Key': `suggestion-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text, url }, 'PermaShip Internal API error (create suggestion)');
      return { success: false, error: `Internal API returned ${response.status}: ${text}` };
    }

    const data = (await response.json()) as SuggestionApiResponse;
    return { success: true, suggestionId: data.suggestion.id };
  } catch (err) {
    logger.error({ err }, 'Failed to create PermaShip suggestion');
    return { success: false, error: (err as Error).message };
  }
}

/** Accept a suggestion to turn it into a real ticket */
export async function acceptSuggestion(
  orgId: string,
  projectId: string,
  suggestionId: string,
): Promise<{ success: boolean; ticketId?: string; status?: string; error?: string }> {
  const url = internalApiUrl(`/projects/${projectId}/suggestions/${suggestionId}/accept`, orgId);
  if (!url) return { success: false, error: 'PermaShip integration not configured' };

  logger.info({ suggestionId, url }, 'Accepting PermaShip suggestion');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...internalAuthHeaders(),
        'X-Idempotency-Key': `accept-${suggestionId}`,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text, url }, 'PermaShip API error (accept suggestion)');
      return { success: false, error: `API returned ${response.status}: ${text}` };
    }

    const data = (await response.json()) as { ticketId: string; status: string };
    return { success: true, ticketId: data.ticketId, status: data.status };
  } catch (err) {
    logger.error({ err }, 'Failed to accept PermaShip suggestion');
    return { success: false, error: (err as Error).message };
  }
}

/** Dismiss a suggestion */
export async function dismissSuggestion(
  orgId: string,
  projectId: string,
  suggestionId: string,
): Promise<{ success: boolean; error?: string }> {
  const url = internalApiUrl(`/projects/${projectId}/suggestions/${suggestionId}/dismiss`, orgId);
  if (!url) return { success: false, error: 'PermaShip integration not configured' };

  logger.info({ suggestionId, url }, 'Dismissing PermaShip suggestion');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...internalAuthHeaders(),
        'X-Idempotency-Key': `dismiss-${suggestionId}`,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text, url }, 'PermaShip API error (dismiss suggestion)');
      return { success: false, error: `API returned ${response.status}: ${text}` };
    }

    return { success: true };
  } catch (err) {
    logger.error({ err }, 'Failed to dismiss PermaShip suggestion');
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Creates a ticket by first creating a suggestion and then immediately accepting it.
 */
export async function createPermashipTicket(
  input: CreateTicketInput,
): Promise<{ success: boolean; ticketId?: string; error?: string }> {
  // 1. Create the suggestion
  const suggestionResult = await createSuggestion(input.orgId, {
    repoKey: input.repoKey,
    title: input.title,
    kind: input.kind,
    description: input.description,
    projectId: input.projectId,
    priority: input.priority,
    labels: input.labels,
  });

  if (!suggestionResult.success || !suggestionResult.suggestionId) {
    return { success: false, error: suggestionResult.error };
  }

  // 2. Accept the suggestion immediately
  const acceptResult = await acceptSuggestion(input.orgId, input.projectId, suggestionResult.suggestionId);

  if (!acceptResult.success || !acceptResult.ticketId) {
    return { success: false, error: acceptResult.error };
  }

  // 3. Store locally for tracking
  try {
    await db.insert(permashipTickets).values({
      orgId: input.orgId,
      remoteTicketId: acceptResult.ticketId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      repoKey: input.repoKey,
      priority: input.priority ?? 3,
      labels: input.labels ?? [],
      createdByAgentId: input.createdByAgentId,
    });

    logger.info({ remoteTicketId: acceptResult.ticketId }, 'PermaShip ticket created (via suggestion)');
    return { success: true, ticketId: acceptResult.ticketId };
  } catch (err) {
    logger.error({ err }, 'Failed to store local ticket record after successful remote creation');
    return { success: true, ticketId: acceptResult.ticketId };
  }
}

/** A suggestion as returned by the PermaShip API */
export interface PermashipSuggestion {
  id: string;
  orgId: string;
  projectId: string;
  repoKey: string;
  title: string;
  kind: 'bug' | 'feature' | 'task';
  description: string;
  affectedFiles: string[];
  status: 'pending' | 'accepted' | 'dismissed' | 'superseded';
  createdAt: string;
  updatedAt: string;
}

/** Fetch pending suggestions for a project from the internal API. Returns empty array on error. */
export async function listSuggestions(
  orgId: string,
  projectId: string,
  params?: { status?: string; repoKey?: string },
): Promise<PermashipSuggestion[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.repoKey) qs.set('repoKey', params.repoKey);
  const q = qs.toString();
  const url = internalApiUrl(`/projects/${projectId}/suggestions${q ? '?' + q : ''}`, orgId);
  if (!url) return [];

  try {
    const response = await fetch(url, { headers: internalAuthHeaders() });
    if (!response.ok) {
      logger.warn({ status: response.status, url }, 'Failed to list suggestions');
      return [];
    }
    const data = (await response.json()) as { suggestions?: PermashipSuggestion[] };
    return data.suggestions ?? [];
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch suggestions from PermaShip API');
    return [];
  }
}

/** Fetch the latest commit for a repo. Returns null on any error. */
export async function fetchLatestCommit(
  orgId: string,
  repoKey: string,
): Promise<{ sha: string; date: string } | null> {
  const url = apiUrl(`/repos/${encodeURIComponent(repoKey)}/commits?limit=1`, orgId);
  if (!url) return null;

  try {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) return null;

    const data = (await response.json()) as { commits?: Array<{ sha: string; date: string }> };
    const commit = data.commits?.[0];
    return commit ? { sha: commit.sha, date: commit.date } : null;
  } catch {
    return null;
  }
}

/** Fetch commits since a given ISO date. Returns null on any error. */
export async function fetchCommitsSince(
  orgId: string,
  repoKey: string,
  since: string,
): Promise<Array<{ sha: string; files: string[] }> | null> {
  const url = apiUrl(
    `/repos/${encodeURIComponent(repoKey)}/commits?since=${encodeURIComponent(since)}`,
    orgId,
  );
  if (!url) return null;

  try {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      commits?: Array<{ sha: string; files?: string[] }>;
    };
    return (data.commits ?? []).map((c) => ({ sha: c.sha, files: c.files ?? [] }));
  } catch {
    return null;
  }
}

// ── Agent Limits ──────────────────────────────────────────────────────────────

interface AgentLimitsResponse {
  maxIdlePromptsPerDay: number;
  planTier: string;
  isOverride: boolean;
}

const agentLimitsCache = new Map<string, { data: AgentLimitsResponse; expiresAt: number }>();
const AGENT_LIMITS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Fetch agent idle limits for an org (cached with 5-min TTL). Returns null on any error. */
export async function fetchAgentLimits(orgId: string): Promise<{ maxIdlePromptsPerDay: number } | null> {
  const cached = agentLimitsCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) {
    return { maxIdlePromptsPerDay: cached.data.maxIdlePromptsPerDay };
  }

  const base = getApiBase();
  if (!base) return null;

  const url = `${base}/api/internal/orgs/${orgId}/agent-limits`;

  try {
    const response = await fetch(url, { headers: internalAuthHeaders() });
    if (!response.ok) {
      logger.warn({ status: response.status, url }, 'Failed to fetch agent limits');
      return null;
    }

    const data = (await response.json()) as AgentLimitsResponse;
    agentLimitsCache.set(orgId, { data, expiresAt: Date.now() + AGENT_LIMITS_CACHE_TTL_MS });
    return { maxIdlePromptsPerDay: data.maxIdlePromptsPerDay };
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch agent limits from PermaShip API');
    return null;
  }
}

/** A knowledge base document from the dashboard */
export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  version: number;
  updatedAt: string;
}

/** Fetch knowledge base documents for a project */
export async function fetchKnowledgeDocuments(
  orgId: string,
  projectId: string,
): Promise<KnowledgeDocument[]> {
  const url = apiUrl(`/projects/${projectId}/knowledge`, orgId);
  if (!url) return [];

  try {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) {
      logger.warn({ status: response.status, url }, 'Failed to fetch knowledge documents');
      return [];
    }
    const data = (await response.json()) as { documents?: KnowledgeDocument[] };
    return data.documents ?? [];
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch knowledge documents from PermaShip API');
    return [];
  }
}

export interface UsagePayload {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  windowStartedAt: string;
}

export async function reportUsage(orgId: string, payload: UsagePayload): Promise<void> {
  const url = internalApiUrl('/usage', orgId);
  if (!url) return;

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...internalAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`reportUsage failed: ${response.status}`);
  }
}

/**
 * Verifies an activation token and returns the associated organization details.
 */
export async function verifyActivationToken(
  token: string,
): Promise<{ success: boolean; orgId?: string; orgName?: string; error?: string }> {
  // We use a global internal endpoint because we don't know the orgId yet
  const base = getApiBase();
  if (!base) {
    return { success: false, error: 'PermaShip integration is not configured (PERMASHIP_API_URL missing)' };
  }

  const url = `${base}/api/internal/activate-agent`;

  logger.info({ url }, 'Verifying activation token');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: internalAuthHeaders(),
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text, url }, 'PermaShip Internal API error (verify token)');
      return { success: false, error: `Invalid or expired activation token (${response.status})` };
    }

    const data = (await response.json()) as { orgId: string; orgName: string };
    return { success: true, orgId: data.orgId, orgName: data.orgName };
  } catch (err) {
    logger.error({ err }, 'Failed to verify activation token');
    return { success: false, error: (err as Error).message };
  }
}
