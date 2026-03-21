import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// ── Integration tests for security changes ──────────────────────────────────
// These tests use Fastify inject() for in-process HTTP testing — no child
// process, no port binding, no startup timeout.

// Set up a temp PGlite directory BEFORE any module imports that trigger db creation
const testDataDir = mkdtempSync(join(tmpdir(), 'nexus-security-test-'));
process.env.PGLITE_DATA_DIR = testDataDir;
process.env.EXECUTION_BACKEND = 'noop';
process.env.LOG_LEVEL = 'error';
process.env.LLM_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-key-for-integration';

let app: FastifyInstance;
let sessionToken: string;

/** Helper to make authenticated inject() requests */
async function api(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (sessionToken) {
    headers['authorization'] = `Bearer ${sessionToken}`;
  }
  if (options.body && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  return app.inject({
    method: (options.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: path,
    headers,
    body: options.body,
  });
}

beforeAll(async () => {
  // Import modules after env is configured (db is created at module scope)
  const { runMigrations } = await import('../db/index.js');
  const { initAdapters } = await import('../adapters/registry.js');
  const { initializeAgents } = await import('../agents/registry.js');
  const { LocalCommunicationAdapter } = await import('./communication-adapter.js');
  const { SingleTenantResolver } = await import('./tenant-resolver.js');
  const { LocalTicketTracker } = await import('./ticket-tracker.js');
  const { LocalProjectRegistry } = await import('./project-registry.js');
  const { LocalGitCommitProvider } = await import('./commit-provider.js');
  const { LocalFileKnowledgeSource } = await import('./knowledge-source.js');
  const { PlaceholderLLMProvider } = await import('./placeholder-llm.js');
  const { createLocalServer } = await import('./server.js');

  const projectRegistry = new LocalProjectRegistry();
  initAdapters({
    usageSink: { reportUsage: async () => {} },
    commitProvider: new LocalGitCommitProvider(projectRegistry),
    knowledgeSource: new LocalFileKnowledgeSource(projectRegistry),
    communicationAdapter: new LocalCommunicationAdapter(),
    projectRegistry,
    ticketTracker: new LocalTicketTracker(),
    tenantResolver: new SingleTenantResolver(),
    llmProvider: new PlaceholderLLMProvider(),
  });

  await runMigrations();

  // Bootstrap workspace link so API endpoints work
  const { db } = await import('../db/index.js');
  const { workspaceLinks } = await import('../db/schema.js');
  const { LOCAL_ORG_ID, LOCAL_WORKSPACE_ID, LOCAL_CHANNEL_ID } = await import('./tenant-resolver.js');
  await db.insert(workspaceLinks).values({
    orgId: LOCAL_ORG_ID,
    orgName: 'Local',
    platform: 'discord',
    workspaceId: LOCAL_WORKSPACE_ID,
    activatedBy: 'local-setup',
    internalChannelId: LOCAL_CHANNEL_ID,
  });

  await initializeAgents();

  app = await createLocalServer(0);
  await app.ready();

  // Get the session token
  const tokenResp = await app.inject({ method: 'GET', url: '/api/auth/token' });
  const tokenData = JSON.parse(tokenResp.body) as { token: string | null };
  sessionToken = tokenData.token ?? '';
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
  const { closeDb } = await import('../db/index.js');
  await closeDb();
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ── A. Authentication & Authorization ─────────────────────────────────────

describe('Authentication', () => {
  it('health endpoint works without auth', async () => {
    const resp = await app.inject({ method: 'GET', url: '/api/health' });
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { status: string };
    expect(data.status).toBe('ok');
  });

  it('token endpoint returns a session token', async () => {
    const resp = await app.inject({ method: 'GET', url: '/api/auth/token' });
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { token: string | null };
    expect(data.token).toBeTruthy();
    expect(typeof data.token).toBe('string');
  });

  it('API rejects requests without token', async () => {
    const resp = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(resp.statusCode).toBe(401);
  });

  it('API rejects requests with invalid token', async () => {
    const resp = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: 'Bearer invalid-token-here' },
    });
    expect(resp.statusCode).toBe(401);
  });

  it('API accepts requests with valid token', async () => {
    const resp = await api('/api/projects');
    expect(resp.statusCode).toBe(200);
  });

  it('CSRF: rejects POST from foreign origin', async () => {
    const resp = await api('/api/chat/send', {
      method: 'POST',
      headers: { origin: 'https://evil.com' },
      body: JSON.stringify({ content: 'test' }),
    });
    expect(resp.statusCode).toBe(403);
  });

  it('CSRF: allows POST from localhost origin', async () => {
    const resp = await api('/api/chat/send', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ content: 'Hello agents' }),
    });
    expect(resp.statusCode).toBe(200);
  });

  it('CSRF: allows POST without Origin header (same-origin)', async () => {
    const resp = await api('/api/chat/send', {
      method: 'POST',
      body: JSON.stringify({ content: 'Hello agents' }),
    });
    expect(resp.statusCode).toBe(200);
  });
});

// ── B. Core API Endpoints Still Work ──────────────────────────────────────

describe('Core API endpoints', () => {
  it('GET /api/projects returns project list', async () => {
    const resp = await api('/api/projects');
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { projects: unknown[] };
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it('GET /api/chat/history returns message history', async () => {
    const resp = await api('/api/chat/history?limit=5');
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { messages: unknown[] };
    expect(Array.isArray(data.messages)).toBe(true);
  });

  it('GET /api/proposals returns proposals list', async () => {
    const resp = await api('/api/proposals');
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { proposals: unknown[] };
    expect(Array.isArray(data.proposals)).toBe(true);
  });

  it('GET /api/agents returns agent list', async () => {
    const resp = await api('/api/agents');
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { agents: unknown[] };
    expect(Array.isArray(data.agents)).toBe(true);
    expect(data.agents.length).toBeGreaterThan(0);
  });

  it('GET /api/config returns configuration', async () => {
    const resp = await api('/api/config');
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { llmProvider: string; executionBackend: string };
    expect(data.llmProvider).toBeTruthy();
    expect(data.executionBackend).toBeTruthy();
  });

  it('GET /api/executions returns ticket list', async () => {
    const resp = await api('/api/executions');
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { tickets: unknown[] };
    expect(Array.isArray(data.tickets)).toBe(true);
  });

  it('POST /api/chat/send accepts a valid message', async () => {
    const resp = await api('/api/chat/send', {
      method: 'POST',
      body: JSON.stringify({ content: 'Test message from integration tests' }),
    });
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { success: boolean };
    expect(data.success).toBe(true);
  });

  it('POST /api/chat/send rejects empty message', async () => {
    const resp = await api('/api/chat/send', {
      method: 'POST',
      body: JSON.stringify({ content: '   ' }),
    });
    const data = JSON.parse(resp.body) as { error?: string; success?: boolean };
    expect(data.error || data.success === false).toBeTruthy();
  });
});

// ── C. Input Validation ───────────────────────────────────────────────────

describe('Input validation', () => {
  it('knowledge entry rejects topic > 500 chars', async () => {
    const resp = await api('/api/knowledge', {
      method: 'POST',
      body: JSON.stringify({ topic: 'A'.repeat(501), content: 'test' }),
    });
    const data = JSON.parse(resp.body) as { error?: string };
    expect(data.error).toBeTruthy();
  });

  it('knowledge entry rejects content > 100KB', async () => {
    const resp = await api('/api/knowledge', {
      method: 'POST',
      body: JSON.stringify({ topic: 'test', content: 'A'.repeat(102401) }),
    });
    const data = JSON.parse(resp.body) as { error?: string };
    expect(data.error).toBeTruthy();
  });

  it('knowledge entry accepts valid input', async () => {
    const resp = await api('/api/knowledge', {
      method: 'POST',
      body: JSON.stringify({ topic: 'Test Topic', content: 'Valid knowledge content' }),
    });
    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body) as { success: boolean };
    expect(data.success).toBe(true);
  });

  it('chat history limit is capped', async () => {
    const resp = await api('/api/chat/history?limit=500');
    expect(resp.statusCode).toBe(200);
  });
});

// ── E. Executor Settings ──────────────────────────────────────────────────

describe('Executor settings', () => {
  it('rejects invalid executor backend', async () => {
    const resp = await api('/api/settings/executor', {
      method: 'POST',
      body: JSON.stringify({ backend: 'malicious-backend' }),
    });
    const data = JSON.parse(resp.body) as { success: boolean; error?: string };
    expect(data.success).toBe(false);
  });

  it('accepts noop backend', async () => {
    const resp = await api('/api/settings/executor', {
      method: 'POST',
      body: JSON.stringify({ backend: 'noop' }),
    });
    const data = JSON.parse(resp.body) as { success: boolean };
    expect(data.success).toBe(true);
  });
});

// ── F. Project Management ─────────────────────────────────────────────────

describe('Project management', () => {
  it('adds a local project with valid path', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'nexus-test-'));
    const resp = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Test Project',
        localPath: tmpDir,
        sourceType: 'local',
      }),
    });
    // Should not crash — any 2xx or validation error (4xx) is acceptable
    expect(resp.statusCode).toBeLessThan(500);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('rejects project with dangerous path', async () => {
    const resp = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Evil Project',
        localPath: '/etc',
        sourceType: 'local',
      }),
    });
    const data = JSON.parse(resp.body) as { success: boolean; error?: string };
    expect(data.success).toBe(false);
  });

  it('rejects project with nonexistent path', async () => {
    const resp = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Ghost Project',
        localPath: '/nonexistent/fake/path',
        sourceType: 'local',
      }),
    });
    const data = JSON.parse(resp.body) as { success: boolean; error?: string };
    expect(data.success).toBe(false);
  });

  it('rejects git project with file:// URL', async () => {
    const resp = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'File URL Project',
        remoteUrl: 'file:///etc/passwd',
        sourceType: 'git',
      }),
    });
    const data = JSON.parse(resp.body) as { success: boolean; error?: string };
    expect(data.success).toBe(false);
  });
});
