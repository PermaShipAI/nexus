import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { processWebhookMessage, type UnifiedMessage, sendAgentMessage } from '../bot/listener.js';
import { getTenantResolver } from '../adapters/registry.js';
import { triggerIdleNow } from '../idle/timer.js';
import { onProposalCreated } from '../nexus/scheduler.js';
import type { AgentId } from '../agents/types.js';
import { db } from '../db/index.js';
import { pendingActions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getTicketTracker, getCommunicationAdapter } from '../adapters/registry.js';
import { parseArgs } from '../utils/parse-args.js';
import { internalChatRoutes } from './internal-chat-routes.js';
import { verifySignedCustomId } from '../bot/interaction-crypto.js';

export const server = Fastify({
  logger: false, // We use our own pino logger
});

// Security headers
server.register(helmet);

// Internal chat routes (admin dashboard API)
server.register(internalChatRoutes);

/**
 * HMAC Verification Middleware
 */
server.addHook('preHandler', async (request, reply) => {
  // Skip HMAC for health checks and internal routes (they use X-Internal-Secret)
  if (request.url === '/health' || request.url.startsWith('/api/internal/')) {
    return;
  }

  if (!config.WEBHOOK_SIGNING_SECRET) {
    logger.warn('WEBHOOK_SIGNING_SECRET not configured, skipping signature verification');
    return;
  }

  const signature = (request.headers['x-hub-signature-256'] || request.headers['x-signature']) as string;
  if (!signature) {
    logger.error('Missing signature header (x-hub-signature-256 or X-Signature)');
    return reply.status(401).send({ error: 'Missing signature' });
  }

  const hmac = createHmac('sha256', config.WEBHOOK_SIGNING_SECRET);
  const payload = JSON.stringify(request.body);
  const digest = hmac.update(payload).digest('hex');
  const prefixedDigest = `sha256=${digest}`;

  const signatureBuffer = Buffer.from(signature, 'utf8');
  
  // Try matching with or without the sha256= prefix
  const matchWithPrefix = signature.startsWith('sha256=') && 
    signatureBuffer.length === Buffer.from(prefixedDigest, 'utf8').length &&
    timingSafeEqual(signatureBuffer, Buffer.from(prefixedDigest, 'utf8'));

  const matchWithoutPrefix = !signature.startsWith('sha256=') &&
    signatureBuffer.length === Buffer.from(digest, 'utf8').length &&
    timingSafeEqual(signatureBuffer, Buffer.from(digest, 'utf8'));

  if (!matchWithPrefix && !matchWithoutPrefix) {
    logger.error({ signature, digest }, 'Invalid HMAC signature');
    return reply.status(401).send({ error: 'Invalid signature' });
  }
});

/**
 * Health Check
 */
server.get('/health', async () => {
  return { status: 'ok' };
});

server.get('/api/internal/health', async () => {
  return { status: 'ok' };
});

/**
 * Internal Link Workspace Route (called from admin dashboard)
 */
server.post('/api/internal/link-workspace', async (request, reply) => {
  const internalSecret = request.headers['x-internal-secret'] as string;
  if (!config.INTERNAL_SECRET || internalSecret !== config.INTERNAL_SECRET) {
    logger.error('Invalid or missing X-Internal-Secret for link-workspace');
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = request.body as any;
  const { orgId, platform, workspaceId, activatedBy, channelId, orgName } = body;

  if (!orgId || !platform || !workspaceId || !activatedBy || !channelId) {
    return reply.status(400).send({ error: 'Missing required fields' });
  }

  const result = await getTenantResolver().linkWorkspace(orgId, platform, workspaceId, activatedBy, channelId, orgName);

  if (result.success) {
    // Send confirmation message to the channel
    const displayName = orgName || 'your organization';
    await sendAgentMessage(channelId, 'System', `✅ **Connected!** This workspace has been linked to ${displayName}.`, orgId);
    return { success: true };
  } else {
    return reply.status(500).send({ error: result.error });
  }
});

/**
 * Trigger an idle prompt immediately (for testing/manual use)
 */
server.post('/api/internal/trigger-idle', async (request, reply) => {
  const internalSecret = request.headers['x-internal-secret'] as string;
  if (!config.INTERNAL_SECRET || internalSecret !== config.INTERNAL_SECRET) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = request.body as { orgId?: string; channelId?: string; agentId?: string };
  if (!body.orgId || !body.channelId) {
    return reply.status(400).send({ error: 'Missing orgId or channelId' });
  }

  triggerIdleNow(body.orgId, body.channelId, body.agentId as AgentId | undefined).catch(err => {
    logger.error({ err }, 'Triggered idle prompt failed');
  });

  return { success: true, message: 'Idle prompt triggered' };
});

/**
 * Trigger repo indexing for an org's repositories.
 * Called when new repos are connected or on initial setup.
 */
server.post('/api/internal/trigger-indexing', async (request, reply) => {
  const internalSecret = request.headers['x-internal-secret'] as string;
  if (!config.INTERNAL_SECRET || internalSecret !== config.INTERNAL_SECRET) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = request.body as { orgId?: string; installationId?: number; repos?: Array<{ id: number; fullName: string }> };
  if (!body.orgId || !body.repos || body.repos.length === 0) {
    return reply.status(400).send({ error: 'Missing orgId or repos' });
  }

  // Run async — don't block the response
  import('../knowledge/repo-indexer.js').then(({ indexAllRepos }) => {
    indexAllRepos(body.orgId!, body.repos!).catch(err => {
      logger.error({ err, orgId: body.orgId }, 'Repo indexing failed');
    });
  });

  return { success: true, message: 'Indexing started', repoCount: body.repos.length };
});

/**
 * Trigger Nexus review cycle immediately (for testing/manual use)
 */
server.post('/api/internal/trigger-nexus', async (request, reply) => {
  const internalSecret = request.headers['x-internal-secret'] as string;
  if (!config.INTERNAL_SECRET || internalSecret !== config.INTERNAL_SECRET) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = request.body as { orgId?: string };
  if (!body.orgId) {
    return reply.status(400).send({ error: 'Missing orgId' });
  }

  onProposalCreated(body.orgId);

  return { success: true, message: 'Nexus review cycle triggered' };
});

/**
 * Webhook Inbound Route
 */
server.post('/v1/webhooks/comms', async (request) => {
  const body = request.body as any;
  logger.info({ 
    platform: body.platform, 
    workspaceId: body.workspace_id,
    threadId: body.thread_id, 
    sender: body.sender_id 
  }, 'Received inbound webhook from Comms');

  // Handle button interactions (approve/reject)
  if (body.event_type === 'interaction.created' && body.interaction) {
    const { custom_id, user } = body.interaction;
    logger.info({ custom_id, user: user?.username }, 'Received interaction webhook');

    const handleInteraction = async () => {
      try {
        const verification = verifySignedCustomId(custom_id);
        if (!verification.valid) {
          const reason = verification.reason;
          logger.error({ event: 'interaction_signature_invalid', reason, custom_id: custom_id.slice(0, 50) }, 'Interaction signature verification failed');
          return;
        }

        const actionId = verification.actionId;
        const isApprove = custom_id.startsWith('approve_tool:');

        if (!actionId) return;

        const [action] = await db
          .select()
          .from(pendingActions)
          .where(eq(pendingActions.id, actionId))
          .limit(1);

        if (!action) {
          logger.warn({ actionId }, 'Action not found for interaction');
          return;
        }

        if (action.status !== 'pending') {
          logger.warn({ event: 'interaction_replay_detected', actionId, status: action.status }, 'Interaction replay detected: action already resolved');
          return;
        }

        const args = parseArgs(action.args);
        const title = (args.title as string) || action.description || 'Proposal';

        if (isApprove) {
          await db.update(pendingActions)
            .set({ status: 'approved', resolvedAt: new Date() })
            .where(eq(pendingActions.id, actionId));

          if (action.suggestionId) {
            // Suggestion already exists in the dashboard — just accept it (creates ticket on platform side)
            const projectId = (args['project-id'] as string) || '';
            await getTicketTracker().acceptSuggestion(action.orgId, projectId, action.suggestionId);
          } else {
            // No suggestion was created (e.g. suggestion creation failed) — create ticket directly
            await getTicketTracker().createTicket({
              orgId: action.orgId,
              kind: (args.kind as 'bug' | 'feature' | 'task') ?? 'task',
              title: args.title as string,
              description: (args.description as string) ?? action.description,
              repoKey: args['repo-key'] as string,
              projectId: (args['project-id'] as string) ?? '',
              priority: args.priority ? parseInt(args.priority as string, 10) : undefined,
              createdByAgentId: action.agentId as AgentId,
            });
          }

          logger.info({ actionId, user: user?.username }, 'Proposal approved via button');
        } else {
          await db.update(pendingActions)
            .set({ status: 'rejected', resolvedAt: new Date() })
            .where(eq(pendingActions.id, actionId));

          // Dismiss the suggestion on the platform side so it doesn't linger in the dashboard
          if (action.suggestionId) {
            const projectId = (args['project-id'] as string) || '';
            await getTicketTracker().dismissSuggestion(action.orgId, projectId, action.suggestionId).catch(err =>
              logger.warn({ err, actionId, suggestionId: action.suggestionId }, 'Failed to dismiss suggestion on reject'),
            );
          }

          logger.info({ actionId, user: user?.username }, 'Proposal rejected via button');
        }

        // Rename the thread with status prefix
        const threadId = body.thread_id;
        if (threadId) {
          const prefix = isApprove ? '✅' : '❌';
          const newName = `${prefix} ${title}`.slice(0, 100);
          await getCommunicationAdapter().renameThread(threadId, newName);
        }
      } catch (err) {
        logger.error({ err, custom_id }, 'Error handling interaction webhook');
      }
    };

    handleInteraction().catch(err => {
      logger.error({ err }, 'Error in interaction handler');
    });

    return { success: true };
  }

  // Ensure channel/thread IDs carry the platform prefix so replies route correctly
  const platform: 'discord' | 'slack' | 'github' =
    body.platform === 'slack' ? 'slack' : body.platform === 'github' ? 'github' : 'discord';
  const rawChannelId = body.channel_id || body.thread_id;
  const prefixedChannelId = rawChannelId?.includes(':') ? rawChannelId : `${platform}:${rawChannelId}`;
  const rawThreadId = body.thread_id;
  const prefixedThreadId = rawThreadId?.includes(':') ? rawThreadId : rawThreadId ? `${platform}:${rawThreadId}` : undefined;
  const rawParentId = body.channel_id;
  const prefixedParentId = rawParentId?.includes(':') ? rawParentId : rawParentId ? `${platform}:${rawParentId}` : undefined;

  const unified: UnifiedMessage = {
    id: body.event_id || `webhook-${Date.now()}`,
    content: body.message?.content || '',
    channelId: prefixedThreadId || prefixedChannelId,
    workspaceId: body.workspace_id || 'unknown',
    authorId: body.sender_id,
    authorName: body.sender_name || 'User',
    isThread: !!body.thread_id && body.thread_id !== body.channel_id,
    parentId: prefixedParentId,
    platform,
    referenceId: body.reference_id,
    platformMessageId: body.message_id,
    orgId: body.org_id,
    enforceReadOnly: body.enforce_read_only === true || body.read_only === true,
    projectHint: body.conductor_project_name || undefined,
  };

  // Process asynchronously — respond immediately so comms doesn't time out
  processWebhookMessage(unified).catch(err => {
    logger.error({ err, eventId: unified.id }, 'Error processing webhook message');
  });

  return { success: true };
});

export async function startServer(): Promise<void> {
  try {
    const port = 9000;

    server.addHook('onClose', async (_instance) => {
      logger.warn('Webhook server is CLOSING');
    });

    server.addHook('onError', async (request, reply, error) => {
      logger.error({ err: error, url: request.url }, 'Fastify server error hook triggered');
    });

    logger.info({ port }, 'Starting webhook server listen...');
    const address = await server.listen({ port, host: '0.0.0.0' });
    logger.info(`Webhook server listening on ${address}`);

  } catch (err) {
    logger.error({ err }, 'FATAL: Failed to start webhook server in startServer() catch block');
    process.exit(1);
  }
}

// Catch-all for crashes not caught by Fastify
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'FATAL UNCAUGHT EXCEPTION - System crashing');
  process.exit(1);
});

process.on('unhandledRejection', (reason, _promise) => {
  logger.error({ reason }, 'UNHANDLED REJECTION');
});
