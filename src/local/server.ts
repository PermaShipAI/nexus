import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import { processWebhookMessage, type UnifiedMessage } from '../bot/listener.js';
import { getAllAgents, registerAgent } from '../agents/registry.js';
import { db } from '../db/index.js';
import { pendingActions, conversationHistory, agents as agentsTable, tickets as ticketsTable, knowledgeEntries, missions as missionsSchema, localProjects as localProjectsSchema } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { getTicketTracker, setTicketTracker } from '../adapters/registry.js';
import { createExecutionBackend } from './execution-backends/factory.js';
import { LocalExecutingTicketTracker } from './executing-ticket-tracker.js';
import { LocalTicketTracker } from './ticket-tracker.js';
import { parseArgs } from '../utils/parse-args.js';
import type { AgentId } from '../agents/types.js';
import { stat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { setLLMProvider } from '../adapters/registry.js';
import { createLLMProvider } from '../adapters/providers/factory.js';
import { localBus } from './communication-adapter.js';
import { LOCAL_ORG_ID, LOCAL_WORKSPACE_ID, LOCAL_CHANNEL_ID } from './tenant-resolver.js';
import { LocalProjectRegistry } from './project-registry.js';
import { cloneRepo } from './git-clone.js';
import { config } from '../config.js';
import { isAutonomousMode, setSetting, getSetting } from '../settings/service.js';
import {
  createMission,
  getMission,
  listMissions,
  updateMissionStatus,
  getMissionItems,
  getMissionProjects,
} from '../missions/service.js';
import { planMission } from '../missions/lifecycle.js';
import { addSharedKnowledge, getSharedKnowledge } from '../knowledge/service.js';
import type { WebSocket } from 'ws';
import {
  generateSessionToken,
  validateSession,
  extractToken,
  getSessionToken,
  isAllowedOrigin,
  validateProjectPath,
  validateGitUrl,
  writeFileSecure,
} from './security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '..', '..', 'ui');

/**
 * Create and configure the Fastify server without starting it.
 * Useful for testing with app.inject().
 */
export async function createLocalServer(_port = 3000) {
  generateSessionToken();

  const server = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024, // M8: 1MB max request body
  });

  await server.register(fastifyWebsocket);
  await server.register(fastifyStatic, {
    root: UI_DIR,
    prefix: '/',
  });

  // ── Security: auth + CSRF for API routes (C1, M2) ────────────────────

  server.addHook('preHandler', async (request, reply) => {
    // Skip auth for static files and health
    if (!request.url.startsWith('/api/') && request.url !== '/ws') return;
    if (request.url === '/api/health') return;
    if (request.url === '/api/auth/token') return;

    // CSRF: reject state-changing requests from non-localhost origins
    if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
      if (!isAllowedOrigin(request)) {
        return reply.status(403).send({ error: 'Forbidden: invalid origin' });
      }
    }

    // Auth: validate session token
    const token = extractToken(request);
    if (!validateSession(token)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  /** Get the session token (for UI to store and attach to requests) */
  server.get('/api/auth/token', async () => {
    return { token: getSessionToken() };
  });

  // ── WebSocket (C2: auth via token query param) ────────────────────────

  const clients = new Set<WebSocket>();

  server.get('/ws', { websocket: true }, (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!validateSession(token ?? undefined)) {
      socket.close(4001, 'Unauthorized');
      return;
    }
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
  });

  function broadcast(event: string, data: unknown) {
    const payload = JSON.stringify({ event, data });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  localBus.on('message', (msg) => broadcast('message', msg));
  localBus.on('reaction', (data) => broadcast('reaction', data));
  localBus.on('thread_rename', (data) => broadcast('thread_rename', data));

  // ── REST: chat API ────────────────────────────────────────────────────

  /** Send a message to Nexus Command */
  server.post('/api/chat/send', async (request) => {
    const { content, authorName } = request.body as {
      content: string;
      authorName?: string;
    };

    if (!content || content.trim().length === 0) {
      return { success: false, error: 'Message content is required' };
    }

    const messageId = `local-${Date.now()}`;
    const unified: UnifiedMessage = {
      id: messageId,
      content: content.trim(),
      channelId: LOCAL_CHANNEL_ID,
      workspaceId: LOCAL_WORKSPACE_ID,
      authorId: 'local-user',
      authorName: authorName ?? 'You',
      isThread: false,
      platform: 'discord',
      orgId: LOCAL_ORG_ID,
    };

    // Broadcast the user message to all connected browsers immediately
    broadcast('user_message', {
      id: messageId,
      content: unified.content,
      authorName: unified.authorName,
      timestamp: new Date().toISOString(),
      channel_id: LOCAL_CHANNEL_ID,
    });

    // Process async (same pattern as the webhook handler)
    processWebhookMessage(unified).catch(err => {
      logger.error({ err }, 'Local message processing failed');
      broadcast('error', { message: 'Message processing failed' });
    });

    return { success: true, messageId };
  });

  /** Get recent chat history */
  server.get('/api/chat/history', async (request) => {
    const { limit } = request.query as { limit?: string };
    const rows = await db
      .select({
        id: conversationHistory.id,
        authorName: conversationHistory.authorName,
        content: conversationHistory.content,
        isAgent: conversationHistory.isAgent,
        agentId: conversationHistory.agentId,
        createdAt: conversationHistory.createdAt,
      })
      .from(conversationHistory)
      .where(
        and(
          eq(conversationHistory.channelId, LOCAL_CHANNEL_ID),
          eq(conversationHistory.orgId, LOCAL_ORG_ID),
        ),
      )
      .orderBy(desc(conversationHistory.createdAt))
      .limit(Math.min(parseInt(limit ?? '50', 10) || 50, 200));

    return { messages: rows.reverse() };
  });

  /** List pending proposals */
  server.get('/api/proposals', async (request) => {
    const { status } = request.query as { status?: string };
    const conditions = [eq(pendingActions.orgId, LOCAL_ORG_ID)];
    if (status) {
      conditions.push(eq(pendingActions.status, status));
    }

    const proposals = await db
      .select()
      .from(pendingActions)
      .where(and(...conditions))
      .orderBy(desc(pendingActions.createdAt))
      .limit(100);

    return { proposals };
  });

  /** Approve a pending action and create the ticket */
  server.post('/api/proposals/:id/approve', async (request) => {
    const { id } = request.params as { id: string };

    const [action] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.id, id))
      .limit(1);

    if (!action) return { success: false, error: 'Action not found' };
    if (action.status !== 'pending') {
      return { success: false, error: `Proposal is already ${action.status}` };
    }

    await db
      .update(pendingActions)
      .set({ status: 'approved', resolvedAt: new Date() })
      .where(eq(pendingActions.id, id));


    broadcast('proposal_resolved', { id, status: 'approved' });


    // Create the actual ticket (triggers execution backend if configured)
    const args = parseArgs(action.args);
    if (action.command === 'create-ticket' && args.title) {
      getTicketTracker().createTicket({
        orgId: action.orgId,
        kind: (args.kind as 'bug' | 'feature' | 'task') ?? 'task',
        title: args.title as string,
        description: (args.description as string) ?? action.description,
        repoKey: (args['repo-key'] as string) ?? 'unknown',
        projectId: (args['project-id'] as string) ?? '',
        priority: args.priority ? parseInt(args.priority as string, 10) : undefined,
        createdByAgentId: action.agentId as AgentId,
      }).catch(err => {
        logger.error({ err, actionId: id }, 'Failed to create ticket after approval');
      });
    }

    return { success: true };
  });

  /** Reject a pending action */
  server.post('/api/proposals/:id/reject', async (request) => {
    const { id } = request.params as { id: string };

    const [action] = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.id, id))
      .limit(1);

    if (!action) return { success: false, error: 'Action not found' };
    if (action.status !== 'pending') {
      return { success: false, error: `Proposal is already ${action.status}` };
    }

    await db
      .update(pendingActions)
      .set({ status: 'rejected', resolvedAt: new Date() })
      .where(eq(pendingActions.id, id));
    broadcast('proposal_resolved', { id, status: 'rejected' });
    return { success: true };
  });


  // ── REST: execution results ────────────────────────────────────────────

  /** List recent tickets with execution results */
  server.get('/api/executions', async () => {
    const rows = await db
      .select()
      .from(ticketsTable)
      .where(eq(ticketsTable.orgId, LOCAL_ORG_ID))
      .orderBy(desc(ticketsTable.createdAt))
      .limit(50);

    return {
      tickets: rows.map(t => ({
        id: t.id,
        title: t.title,
        kind: t.kind,
        repoKey: t.repoKey,
        createdByAgentId: t.createdByAgentId,
        executionStatus: t.executionStatus,
        executionBackend: t.executionBackend,
        executionReview: t.executionReview,
        executedAt: t.executedAt,
        createdAt: t.createdAt,
      })),
    };
  });

  /** Get full execution details for a specific ticket */
  server.get('/api/executions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const [ticket] = await db.select().from(ticketsTable).where(eq(ticketsTable.id, id)).limit(1);
    if (!ticket) return { error: 'Ticket not found' };
    return { ticket };
  });

  /** Retry a failed execution */
  server.post('/api/executions/:id/retry', async (request) => {
    const { id } = request.params as { id: string };
    const tracker = getTicketTracker();
    if (!('retryExecution' in tracker)) {
      return { success: false, error: 'Execution retries require an active execution backend (not noop).' };
    }
    const result = await (tracker as any).retryExecution(id);
    if (result.success) {
      broadcast('execution_retry', { id });
    }
    return result;
  });

  // ── REST: knowledge base ───────────────────────────────────────────────

  /** List all shared knowledge entries */
  server.get('/api/knowledge', async () => {
    const entries = await getSharedKnowledge(LOCAL_ORG_ID);
    return {
      entries: entries.map(e => ({
        id: e.id,
        topic: e.topic,
        content: e.content,
        sourceId: e.sourceId,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    };
  });

  /** Add a knowledge entry */
  server.post('/api/knowledge', async (request) => {
    const { topic, content } = request.body as { topic: string; content: string };
    if (!topic?.trim()) return { success: false, error: 'Topic is required' };
    if (!content?.trim()) return { success: false, error: 'Content is required' };
    if (topic.length > 500) return { success: false, error: 'Topic must be under 500 characters' };
    if (content.length > 100_000) return { success: false, error: 'Content must be under 100KB' };

    const entry = await addSharedKnowledge(LOCAL_ORG_ID, topic.trim(), content.trim());
    broadcast('knowledge_changed', { action: 'added', id: entry.id });
    return { success: true, entry: { id: entry.id, topic: entry.topic } };
  });

  /** Delete a knowledge entry */
  server.delete('/api/knowledge/:id', async (request) => {
    const { id } = request.params as { id: string };
    const deleted = await db
      .delete(knowledgeEntries)
      .where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.orgId, LOCAL_ORG_ID)))
      .returning({ id: knowledgeEntries.id });
    if (deleted.length > 0) broadcast('knowledge_changed', { action: 'removed', id });
    return { success: deleted.length > 0 };
  });

  // ── REST: project management ───────────────────────────────────────────

  const projectRegistry = new LocalProjectRegistry();

  /** List all projects */
  server.get('/api/projects', async () => {
    const projects = await projectRegistry.getAllProjects(LOCAL_ORG_ID);
    return { projects };
  });

  /** Add a project (local folder or git URL) */
  server.post('/api/projects', async (request) => {
    const { name, localPath, remoteUrl } = request.body as {
      name: string;
      localPath?: string;
      remoteUrl?: string;
    };

    if (!name?.trim()) {
      return { success: false, error: 'Project name is required' };
    }

    if (localPath) {
      // M3: Validate path against traversal attacks
      const pathCheck = validateProjectPath(localPath);
      if (!pathCheck.valid) {
        return { success: false, error: pathCheck.error };
      }
      try {
        const st = await stat(pathCheck.resolved);
        if (!st.isDirectory()) {
          return { success: false, error: 'Path is not a directory' };
        }
      } catch {
        return { success: false, error: 'Path does not exist' };
      }

      // Initialize git if not already a repo (needed for diff tracking)
      try {
        await stat(join(pathCheck.resolved, '.git'));
      } catch {
        try {
          await execFileAsync('git', ['init'], { cwd: pathCheck.resolved, timeout: 10_000 });
          await execFileAsync('git', ['add', '.'], { cwd: pathCheck.resolved, timeout: 30_000 });
          await execFileAsync('git', ['commit', '-m', 'Initial commit (auto-created by Nexus Command)'], {
            cwd: pathCheck.resolved,
            timeout: 30_000,
            env: { ...process.env, GIT_AUTHOR_NAME: 'Nexus Command', GIT_AUTHOR_EMAIL: 'nexus@local', GIT_COMMITTER_NAME: 'Nexus Command', GIT_COMMITTER_EMAIL: 'nexus@local' },
          });
          logger.info({ path: pathCheck.resolved }, 'Initialized git repo for project');
        } catch (gitErr) {
          logger.warn({ err: gitErr, path: pathCheck.resolved }, 'Could not initialize git — diff tracking will be unavailable');
        }
      }

      const project = await projectRegistry.addProject(LOCAL_ORG_ID, name.trim(), localPath, 'local');
      broadcast('project_added', project);
      return { success: true, project };
    }

    if (remoteUrl) {
      // M4: Validate git URL protocol
      const urlCheck = validateGitUrl(remoteUrl);
      if (!urlCheck.valid) {
        return { success: false, error: urlCheck.error };
      }
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const targetPath = join(config.LOCAL_REPOS_DIR ?? './repos', slug);

      const project = await projectRegistry.addProject(LOCAL_ORG_ID, name.trim(), targetPath, 'git', remoteUrl);
      broadcast('project_added', project);

      // Clone in background
      cloneRepo(project.id, remoteUrl, targetPath, projectRegistry).catch(err => {
        logger.error({ err, projectId: project.id }, 'Background clone failed');
      });

      return { success: true, project, cloning: true };
    }

    return { success: false, error: 'Either localPath or remoteUrl is required' };
  });

  /** Remove a project */
  server.delete('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const removed = await projectRegistry.removeProject(id, LOCAL_ORG_ID);
    if (removed) broadcast('project_removed', { id });
    return { success: removed };
  });

  // ── REST: config and settings ──────────────────────────────────────────

  /** Get system configuration (read-only) */
  /** Get system configuration (read-only) */
  server.get('/api/config', async () => {
    const autonomous = await isAutonomousMode(LOCAL_ORG_ID);
    const useWorktrees = await getSetting('use_worktrees', LOCAL_ORG_ID) === true;
    const projects = await projectRegistry.getAllProjects(LOCAL_ORG_ID);
    const hasKey = config.LLM_PROVIDER === 'ollama' || !!(process.env.LLM_API_KEY || process.env.GEMINI_API_KEY);
    return {
      llmProvider: config.LLM_PROVIDER,
      executionBackend: config.EXECUTION_BACKEND,
      autonomousMode: autonomous,
      useWorktrees,
      projectCount: projects.length,
      needsSetup: !hasKey,
    };
  });

  /** Complete initial setup — set LLM provider and API key */
  server.post('/api/setup', async (request) => {
    const { provider, apiKey } = request.body as { provider: string; apiKey?: string };

    if (!provider) return { success: false, error: 'Provider is required' };
    if (provider !== 'ollama' && !apiKey) return { success: false, error: 'API key is required for this provider' };

    // Write to .env file so it persists across restarts
    try {
      const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
      let envContent = '';
      try { envContent = await readFile(envPath, 'utf-8'); } catch { /* no .env yet */ }

      // Update or append each key
      const updates: Record<string, string> = { LLM_PROVIDER: provider };
      if (provider === 'gemini') {
        updates.GEMINI_API_KEY = apiKey ?? '';
      } else if (provider !== 'ollama') {
        updates.LLM_API_KEY = apiKey ?? '';
      }

      for (const [key, value] of Object.entries(updates)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
          envContent += `\n${key}=${value}`;
        }
        // Also update the running process env so createLLMProvider picks it up
        process.env[key] = value;
      }

      writeFileSecure(envPath, envContent.trim() + '\n');

      // Hot-swap the LLM provider
      const newProvider = createLLMProvider();
      setLLMProvider(newProvider);

      logger.info({ provider }, 'LLM provider configured via setup');
      broadcast('settings_changed', { llmProvider: provider, needsSetup: false });
      return { success: true };
    } catch (err) {
      logger.error({ err }, 'Setup failed');
      return { success: false, error: (err as Error).message };
    }
  });

  /** Change execution backend */
  // Shared executor test logic used by both selection and explicit test endpoints
  const cliBackendInfo: Record<string, { command: string; testArgs: string[]; name: string; install: string }> = {
    'claude-code': {
      command: 'claude',
      testArgs: ['--version'],
      name: 'Claude Code',
      install: 'npm install -g @anthropic-ai/claude-code\n\nMore info: https://docs.anthropic.com/en/docs/claude-code',
    },
    'gemini-cli': {
      command: 'gemini',
      testArgs: ['--version'],
      name: 'Gemini CLI',
      install: 'npm install -g @google/gemini-cli\n\nMore info: https://ai.google.dev/gemini-api/docs/gemini-cli',
    },
    'codex-cli': {
      command: 'codex',
      testArgs: ['--version'],
      name: 'Codex CLI',
      install: 'npm install -g @openai/codex\n\nMore info: https://github.com/openai/codex',
    },
    'openclaw': {
      command: 'openclaw',
      testArgs: ['--version'],
      name: 'OpenClaw',
      install: 'See https://github.com/openclaw/openclaw for installation instructions.',
    },
  };

  async function testExecutorBackend(backend: string): Promise<{ available: boolean; message: string; help?: string }> {
    if (backend === 'noop') {
      return { available: true, message: 'No executor — approved tickets will be tracked but not executed.' };
    }

    if (backend === 'permaship') {
      const hasKey = !!process.env.PERMASHIP_API_KEY;
      return hasKey
        ? { available: true, message: 'PermaShip API key is configured.' }
        : { available: false, message: 'PermaShip API key is not configured.', help: 'Sign up at https://permaship.ai/pricing to get your API credentials, then set PERMASHIP_API_KEY in your .env file.' };
    }

    const cli = cliBackendInfo[backend];
    if (!cli) {
      return { available: false, message: `Unknown backend: ${backend}` };
    }

    try {
      const { stdout } = await execFileAsync(cli.command, cli.testArgs, { timeout: 10_000 });
      const version = stdout.trim().split('\n')[0];
      return { available: true, message: `${cli.name} found: ${version}` };
    } catch (err) {
      const msg = (err as Error).message;
      const notFound = msg.includes('ENOENT') || msg.includes('not found');
      return {
        available: false,
        message: notFound
          ? `${cli.name} is not installed or not in your PATH.`
          : `${cli.name} check failed: ${msg.split('\n')[0]}`,
        help: `To install ${cli.name}:\n\n${cli.install}`,
      };
    }
  }

  server.post('/api/settings/executor', async (request) => {
    const { backend } = request.body as { backend: string };
    const valid = ['noop', 'claude-code', 'gemini-cli', 'codex-cli', 'openclaw', 'permaship'];
    if (!valid.includes(backend)) return { success: false, error: `Invalid backend. Options: ${valid.join(', ')}` };

    // Auto-test the backend before saving
    const testResult = await testExecutorBackend(backend);
    if (!testResult.available) {
      return { success: false, error: testResult.message, help: testResult.help, testResult };
    }

    try {
      const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
      let envContent = '';
      try { envContent = await readFile(envPath, 'utf-8'); } catch { /* no .env yet */ }

      const regex = /^EXECUTION_BACKEND=.*$/m;
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `EXECUTION_BACKEND=${backend}`);
      } else {
        envContent += `\nEXECUTION_BACKEND=${backend}`;
      }
      process.env.EXECUTION_BACKEND = backend;
      writeFileSecure(envPath, envContent.trim() + '\n');

      // Hot-swap the ticket tracker so the new backend takes effect immediately
      if (backend !== 'noop') {
        const newBackend = createExecutionBackend(backend);
        const execTracker = new LocalExecutingTicketTracker(newBackend, process.env.REPO_ROOT ?? '.');
        setTicketTracker(execTracker);
        logger.info({ backend }, 'Execution backend hot-swapped');
      } else {
        setTicketTracker(new LocalTicketTracker());
        logger.info('Execution backend set to noop');
      }

      broadcast('settings_changed', { executionBackend: backend });
      return { success: true, executionBackend: backend, testResult };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /** Test if an execution backend is available and working */
  server.post('/api/settings/executor/test', async (request) => {
    const { backend } = request.body as { backend: string };
    return testExecutorBackend(backend);
  });

  /** Toggle autonomous mode */
  server.post('/api/settings/autonomous', async (request) => {
    const { enabled } = request.body as { enabled: boolean };
    await setSetting('autonomous_mode', enabled, LOCAL_ORG_ID, 'local-ui');
    broadcast('settings_changed', { autonomousMode: enabled });
    return { success: true, autonomousMode: enabled };
  });

  server.post('/api/settings/worktrees', async (request) => {
    const { enabled } = request.body as { enabled: boolean };
    await setSetting('use_worktrees', enabled, LOCAL_ORG_ID, 'local-ui');
    broadcast('settings_changed', { useWorktrees: enabled });
    return { success: true, useWorktrees: enabled };
  });

  // ── REST: agent management ─────────────────────────────────────────────

  /** List agents with enabled/disabled state */
  server.get('/api/agents', async () => {
    const all = getAllAgents();
    const disabledRaw = await getSetting('disabled_agents', LOCAL_ORG_ID) as string[] | null;
    const disabled = new Set(disabledRaw ?? []);
    return {
      agents: all.map(a => ({
        id: a.id,
        title: a.title,
        summary: a.summary,
        enabled: !disabled.has(a.id),
      })),
    };
  });

  /** Toggle an agent on/off */
  server.post('/api/agents/:id/toggle', async (request) => {
    const { id } = request.params as { id: string };
    const { enabled } = request.body as { enabled: boolean };
    const disabledRaw = await getSetting('disabled_agents', LOCAL_ORG_ID) as string[] | null;
    const disabled = new Set(disabledRaw ?? []);
    if (enabled) { disabled.delete(id); } else { disabled.add(id); }
    await setSetting('disabled_agents', Array.from(disabled), LOCAL_ORG_ID, 'local-ui');
    broadcast('settings_changed', { agents: true });
    return { success: true };
  });

  /** Update an agent's persona */
  server.put('/api/agents/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { title, personaMd } = request.body as { title?: string; personaMd?: string };
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (title) updates.title = title;
    if (personaMd) updates.personaMd = personaMd;
    await db.update(agentsTable).set(updates).where(eq(agentsTable.id, id));
    return { success: true };
  });

  /** Preview available agents from a GitHub repo (scans category directories) */
  server.post('/api/agents/import/preview', async (request) => {
    const { url } = request.body as { url: string };
    if (!url) return { success: false, error: 'URL is required' };

    try {
      const ghMatch = url.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!ghMatch) return { success: false, error: 'Please provide a GitHub URL (https://github.com/user/repo)' };

      const [, owner, repo] = ghMatch;
      const ghHeaders = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'agent-system' };

      // Fetch root contents
      const rootResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`, { headers: ghHeaders });
      if (!rootResp.ok) {
        return { success: false, error: `GitHub API returned ${rootResp.status}. Is the repo public?` };
      }

      const rootEntries = await rootResp.json() as Array<{ name: string; path: string; download_url: string | null; type: string }>;

      // Scan directories for .md files (skip meta dirs)
      const skipDirs = new Set(['.github', 'scripts', 'examples', 'node_modules', '.git']);
      const dirs = rootEntries.filter(e => e.type === 'dir' && !skipDirs.has(e.name));

      type GhFile = { name: string; path: string; download_url: string };
      const allMdFiles: GhFile[] = [];

      // Collect root-level .md files
      for (const f of rootEntries) {
        if (f.type === 'file' && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md' && f.download_url) {
          allMdFiles.push({ name: f.name, path: f.path, download_url: f.download_url });
        }
      }

      // Scan each category directory
      for (const dir of dirs) {
        try {
          const dirResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${dir.path}`, { headers: ghHeaders });
          if (!dirResp.ok) continue;
          const dirEntries = await dirResp.json() as Array<{ name: string; path: string; download_url: string | null; type: string }>;
          for (const f of dirEntries) {
            if (f.type === 'file' && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md' && f.download_url) {
              allMdFiles.push({ name: f.name, path: f.path, download_url: f.download_url });
            }
          }
        } catch { /* skip */ }
      }

      if (allMdFiles.length === 0) {
        return { success: false, error: 'No .md persona files found in the repo.' };
      }

      const available: Array<{ id: string; title: string; category: string; filename: string; downloadUrl: string; alreadyImported: boolean }> = [];

      for (const file of allMdFiles) {
        const agentId = file.name.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const displayName = file.name.replace(/\.md$/, '').replace(/[-_]/g, ' ');
        const category = file.path.includes('/') ? file.path.split('/')[0] : 'general';
        const existing = getAllAgents().find(a => a.id === agentId);

        available.push({
          id: agentId,
          title: displayName,
          category,
          filename: file.name,
          downloadUrl: file.download_url,
          alreadyImported: !!existing,
        });
      }

      available.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
      const categories = [...new Set(available.map(a => a.category))];

      return { success: true, agents: available, categories, repoUrl: url };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /** Import selected agents from a GitHub repo */
  server.post('/api/agents/import', async (request) => {
    const { agents: selections } = request.body as {
      agents: Array<{ id: string; filename: string; downloadUrl: string }>;
    };

    if (!selections?.length) return { success: false, error: 'No agents selected' };

    const imported: string[] = [];
    const failed: string[] = [];
    const matter = (await import('gray-matter')).default;

    for (const sel of selections) {
      try {
        const resp = await fetch(sel.downloadUrl);
        if (!resp.ok) { failed.push(sel.filename); continue; }
        const content = await resp.text();
        const { data: frontmatter, content: body } = matter(content);

        const agentId = sel.id as AgentId;
        const title = (frontmatter.title as string) ?? (frontmatter.name as string) ?? sel.filename.replace(/\.md$/, '').replace(/[-_]/g, ' ');
        const summary = body.match(/^#+\s*(?:summary|one.line|overview)[^\n]*\n+(.+)/im)?.[1]?.trim() ?? '';

        // Upsert into DB
        const [existing] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1);
        if (existing) {
          await db.update(agentsTable).set({ title, personaMd: body, updatedAt: new Date() }).where(eq(agentsTable.id, agentId));
        } else {
          await db.insert(agentsTable).values({ id: agentId, title, personaMd: body });
        }

        registerAgent({ id: agentId, title, summary, personaMd: body });
        imported.push(title);
      } catch {
        failed.push(sel.filename);
      }
    }

    broadcast('settings_changed', { agents: true });
    return { success: true, imported: imported.length, names: imported, failed: failed.length };
  });

  // ── REST: heartbeat / scheduler settings ──────────────────────────────

  const HEARTBEAT_KEYS = [
    { key: 'idle_timeout_ms', label: 'Idle Timeout', envKey: 'IDLE_TIMEOUT_MS', default: 1_200_000, unit: 'ms' },
    { key: 'cto_review_interval_ms', label: 'Nexus Review Interval', envKey: 'CTO_REVIEW_INTERVAL_MS', default: 14_400_000, unit: 'ms' },
    { key: 'cto_debounce_ms', label: 'Nexus Debounce', envKey: 'CTO_DEBOUNCE_MS', default: 120_000, unit: 'ms' },
    { key: 'staleness_check_interval_ms', label: 'Staleness Check Interval', envKey: 'STALENESS_CHECK_INTERVAL_MS', default: 7_200_000, unit: 'ms' },
    { key: 'knowledge_sync_interval_ms', label: 'Knowledge Sync Interval', envKey: 'KNOWLEDGE_SYNC_INTERVAL_MS', default: 900_000, unit: 'ms' },
  ] as const;

  /** Get heartbeat settings */
  server.get('/api/settings/heartbeats', async () => {
    const heartbeats: Record<string, { label: string; value: number; unit: string }> = {};
    for (const hb of HEARTBEAT_KEYS) {
      const saved = await getSetting(hb.key, LOCAL_ORG_ID) as number | null;
      heartbeats[hb.key] = {
        label: hb.label,
        value: saved ?? (parseInt(process.env[hb.envKey] ?? '', 10) || hb.default),
        unit: hb.unit,
      };
    }
    return { heartbeats };
  });

  /** Update a heartbeat setting */
  server.put('/api/settings/heartbeats', async (request) => {
    const { key, value } = request.body as { key: string; value: number };
    const hb = HEARTBEAT_KEYS.find(h => h.key === key);
    if (!hb) return { success: false, error: 'Unknown heartbeat key' };
    if (typeof value !== 'number' || value < 0) return { success: false, error: 'Value must be a positive number' };
    if (value > 86_400_000) return { success: false, error: 'Value must be 24 hours or less' };
    await setSetting(key, value, LOCAL_ORG_ID, 'local-ui');
    broadcast('settings_changed', { heartbeats: true });
    return { success: true };
  });

  // ── REST: missions ───────────────────────────────────────────────────

  /** List all missions */
  server.get('/api/missions', async (request) => {
    const { status } = request.query as { status?: string };
    const missionList = await listMissions(LOCAL_ORG_ID, status);
    return { missions: missionList };
  });

  /** Get mission + checklist + projects */
  server.get('/api/missions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const mission = await getMission(id, LOCAL_ORG_ID);
    if (!mission) return { error: 'Mission not found' };
    const items = await getMissionItems(id);
    const projects = await getMissionProjects(id);
    return { mission, items, projects };
  });

  /** Create a new mission */
  server.post('/api/missions', async (request) => {
    const { title, description, projectIds, heartbeatIntervalMs, cronExpression, autonomousMode } = request.body as {
      title: string;
      description: string;
      projectIds?: string[];
      heartbeatIntervalMs?: number;
      cronExpression?: string;
      autonomousMode?: boolean | null;
    };

    if (!title?.trim()) return { success: false, error: 'Title is required' };
    if (!description?.trim()) return { success: false, error: 'Description is required' };
    if (title.length > 500) return { success: false, error: 'Title must be under 500 characters' };
    if (description.length > 10_000) return { success: false, error: 'Description must be under 10KB' };

    const mission = await createMission({
      orgId: LOCAL_ORG_ID,
      title: title.trim(),
      description: description.trim(),
      projectIds,
      heartbeatIntervalMs,
      cronExpression,
      autonomousMode: autonomousMode ?? null,
    });

    broadcast('mission_created', mission);

    // Kick off planning in background
    planMission(mission.id, LOCAL_ORG_ID).catch(err => {
      logger.error({ err, missionId: mission.id }, 'Mission planning failed');
    });

    return { success: true, mission };
  });

  /** Update mission status (pause/resume/cancel) */
  server.post('/api/missions/:id/status', async (request) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: string };

    const validStatuses = ['active', 'paused', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return { success: false, error: `Status must be one of: ${validStatuses.join(', ')}` };
    }

    const mission = await updateMissionStatus(id, LOCAL_ORG_ID, status as any);
    if (!mission) return { success: false, error: 'Mission not found' };

    broadcast('mission_updated', mission);
    return { success: true, mission };
  });

  /** Re-trigger mission planning (generates checklist items) */
  server.post('/api/missions/:id/plan', async (request) => {
    const { id } = request.params as { id: string };
    try {
      await planMission(id, LOCAL_ORG_ID);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /** Remove duplicate checklist items from a mission */
  server.post('/api/missions/:id/dedup', async (request) => {
    const { id } = request.params as { id: string };
    const { dedupMissionItems } = await import('../missions/service.js');
    const removed = await dedupMissionItems(id);
    return { success: true, removed };
  });

  /** Get chat history for a mission channel */
  server.get('/api/missions/:id/chat', async (request) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };

    const mission = await getMission(id, LOCAL_ORG_ID);
    if (!mission) return { error: 'Mission not found' };

    const rows = await db
      .select({
        id: conversationHistory.id,
        authorName: conversationHistory.authorName,
        content: conversationHistory.content,
        isAgent: conversationHistory.isAgent,
        agentId: conversationHistory.agentId,
        createdAt: conversationHistory.createdAt,
      })
      .from(conversationHistory)
      .where(
        and(
          eq(conversationHistory.channelId, mission.channelId),
          eq(conversationHistory.orgId, LOCAL_ORG_ID),
        ),
      )
      .orderBy(desc(conversationHistory.createdAt))
      .limit(Math.min(parseInt(limit ?? '50', 10) || 50, 200));

    return { messages: rows.reverse() };
  });

  /** Send a message to a mission channel */
  server.post('/api/missions/:id/chat/send', async (request) => {
    const { id } = request.params as { id: string };
    const { content, authorName } = request.body as { content: string; authorName?: string };

    if (!content || content.trim().length === 0) {
      return { success: false, error: 'Message content is required' };
    }

    const mission = await getMission(id, LOCAL_ORG_ID);
    if (!mission) return { success: false, error: 'Mission not found' };

    const messageId = `local-${Date.now()}`;
    const unified: UnifiedMessage = {
      id: messageId,
      content: content.trim(),
      channelId: mission.channelId,
      workspaceId: LOCAL_WORKSPACE_ID,
      authorId: 'local-user',
      authorName: authorName ?? 'You',
      isThread: false,
      platform: 'discord',
      orgId: LOCAL_ORG_ID,
    };

    broadcast('user_message', {
      id: messageId,
      content: unified.content,
      authorName: unified.authorName,
      timestamp: new Date().toISOString(),
      channel_id: mission.channelId,
    });

    processWebhookMessage(unified).catch(err => {
      logger.error({ err }, 'Mission message processing failed');
      broadcast('error', { message: 'Message processing failed' });
    });

    return { success: true, messageId };
  });

  /** Update mission heartbeat interval */
  server.put('/api/missions/:id/heartbeat', async (request) => {
    const { id } = request.params as { id: string };
    const { intervalMs } = request.body as { intervalMs: number };

    if (typeof intervalMs !== 'number' || intervalMs < 60_000) {
      return { success: false, error: 'Interval must be at least 60 seconds' };
    }
    if (intervalMs > 86_400_000) {
      return { success: false, error: 'Interval must be 24 hours or less' };
    }

    const { missions: missionsTable } = await import('../db/schema.js');
    await db
      .update(missionsTable)
      .set({ heartbeatIntervalMs: intervalMs, updatedAt: new Date() })
      .where(eq(missionsTable.id, id));

    broadcast('mission_updated', { id, heartbeatIntervalMs: intervalMs });
    return { success: true };
  });

  /** Toggle autonomous mode for a mission */
  server.put('/api/missions/:id/autonomous', async (request) => {
    const { id } = request.params as { id: string };
    const { enabled } = request.body as { enabled: boolean | null };
    const value = enabled === null ? null : !!enabled;

    const [mission] = await db
      .update(missionsSchema)
      .set({ autonomousMode: value, updatedAt: new Date() })
      .where(and(eq(missionsSchema.id, id), eq(missionsSchema.orgId, LOCAL_ORG_ID)))
      .returning();

    if (!mission) return { success: false, error: 'Mission not found' };
    broadcast('mission_updated', mission);
    return { success: true, autonomousMode: mission.autonomousMode };
  });

  /** Toggle autonomous mode for a project */
  server.put('/api/projects/:id/autonomous', async (request) => {
    const { id } = request.params as { id: string };
    const { enabled } = request.body as { enabled: boolean | null };
    const value = enabled === null ? null : !!enabled;

    const [project] = await db
      .update(localProjectsSchema)
      .set({ autonomousMode: value, updatedAt: new Date() })
      .where(and(eq(localProjectsSchema.id, id), eq(localProjectsSchema.orgId, LOCAL_ORG_ID)))
      .returning();

    if (!project) return { success: false, error: 'Project not found' };
    broadcast('settings_changed', { projectAutonomous: { id, enabled: project.autonomousMode } });
    return { success: true, autonomousMode: project.autonomousMode };
  });

  // ── REST: branch management ────────────────────────────────────────────

  /** List branches with ticket data */
  server.get('/api/branches', async () => {
    const { listBranches } = await import('./branch-manager.js');
    const branches = await listBranches(LOCAL_ORG_ID);
    return { branches };
  });

  /** Merge a ticket's branch */
  server.post('/api/branches/:ticketId/merge', async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    const { mergeTicketBranch } = await import('./branch-manager.js');
    const result = await mergeTicketBranch(ticketId, LOCAL_ORG_ID);
    if (result.success) broadcast('branch_merged', { ticketId });
    return result;
  });

  /** Clean up a merged branch */
  server.post('/api/branches/:ticketId/cleanup', async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    const [ticket] = await db.select().from(ticketsTable).where(eq(ticketsTable.id, ticketId)).limit(1);
    if (!ticket?.executionBranch) return { success: false, error: 'No branch to clean up' };

    const { getProjectRegistry: getPR } = await import('../adapters/registry.js');
    const registry = getPR();
    let repoPath: string | null = null;
    if ('getProjectByRepoKey' in registry) {
      const project = await (registry as any).getProjectByRepoKey(ticket.repoKey, LOCAL_ORG_ID);
      repoPath = project?.localPath ?? null;
    }
    if (!repoPath) return { success: false, error: 'Project not found' };

    const { cleanupBranch } = await import('./branch-manager.js');
    await cleanupBranch(repoPath, ticket.executionBranch);
    return { success: true };
  });

  /** Get merge target branch setting */
  server.get('/api/settings/merge-target', async () => {
    const { getSetting: getS } = await import('../settings/service.js');
    const value = await getS('merge_target_branch', LOCAL_ORG_ID);
    return { branch: value ?? null };
  });

  /** Set merge target branch */
  server.post('/api/settings/merge-target', async (request) => {
    const { branch } = request.body as { branch: string };
    if (!branch?.trim()) return { success: false, error: 'Branch name required' };
    const { setSetting: setS } = await import('../settings/service.js');
    await setS('merge_target_branch', branch.trim(), LOCAL_ORG_ID, 'local-ui');
    return { success: true, branch: branch.trim() };
  });

  /** Health check */
  server.get('/api/health', async () => ({ status: 'ok' }));

  return server;
}

export async function startLocalServer(port = 3000): Promise<void> {
  const server = await createLocalServer(port);

  try {
    const address = await server.listen({ port, host: '0.0.0.0' });
    logger.info(`Local UI server listening on ${address}`);
    console.log(`\n  🤖 Agent Chat UI: http://localhost:${port}\n`);
  } catch (err) {
    logger.error({ err }, 'Failed to start local server');
    process.exit(1);
  }
}
