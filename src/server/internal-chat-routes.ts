import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, lt, gt, ilike, sql, count } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationHistory, workspaceLinks, agents } from '../db/schema.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// =============================================================================
// Auth helper
// =============================================================================

function requireInternalSecret(request: any, reply: any): boolean {
  const secret = request.headers['x-internal-secret'] as string;
  if (!config.INTERNAL_SECRET || secret !== config.INTERNAL_SECRET) {
    logger.error('Invalid or missing X-Internal-Secret for chat route');
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// =============================================================================
// Internal Chat Routes — admin dashboard API
// =============================================================================

export const internalChatRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/internal/chat/organizations
   * All orgs with active workspace links, channel counts, last activity
   */
  fastify.get('/api/internal/chat/organizations', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;

    // Get workspace links with aggregated channel stats
    const links = await db
      .select({
        orgId: workspaceLinks.orgId,
        orgName: workspaceLinks.orgName,
        platform: workspaceLinks.platform,
        workspaceId: workspaceLinks.workspaceId,
      })
      .from(workspaceLinks)
      .orderBy(workspaceLinks.orgName);

    // Get per-org channel counts and last activity from conversation_history
    const orgStats = await db
      .select({
        orgId: conversationHistory.orgId,
        channelCount: sql<number>`COUNT(DISTINCT ${conversationHistory.channelId})::int`,
        lastActivity: sql<string>`MAX(${conversationHistory.createdAt})::text`,
        messageCount: count(),
      })
      .from(conversationHistory)
      .groupBy(conversationHistory.orgId);

    const statsMap = new Map(orgStats.map((s) => [s.orgId, s]));

    const organizations = links.map((link) => {
      const stats = statsMap.get(link.orgId);
      return {
        orgId: link.orgId,
        orgName: link.orgName ?? 'Unknown',
        platform: link.platform,
        workspaceId: link.workspaceId,
        channelCount: stats?.channelCount ?? 0,
        messageCount: stats?.messageCount ?? 0,
        lastActivity: stats?.lastActivity ?? null,
      };
    });

    return { organizations };
  });

  /**
   * GET /api/internal/chat/organizations/:orgId/channels
   * Channels for an org with message counts, last activity
   */
  fastify.get('/api/internal/chat/organizations/:orgId/channels', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;

    const { orgId } = request.params as { orgId: string };

    const channels = await db
      .select({
        channelId: conversationHistory.channelId,
        messageCount: count(),
        agentMessageCount: sql<number>`COUNT(*) FILTER (WHERE ${conversationHistory.isAgent} = true)::int`,
        lastMessageAt: sql<string>`MAX(${conversationHistory.createdAt})::text`,
        firstMessageAt: sql<string>`MIN(${conversationHistory.createdAt})::text`,
      })
      .from(conversationHistory)
      .where(eq(conversationHistory.orgId, orgId))
      .groupBy(conversationHistory.channelId)
      .orderBy(sql`MAX(${conversationHistory.createdAt}) DESC`);

    return { channels };
  });

  /**
   * GET /api/internal/chat/channels/:channelId/messages
   * Paginated messages for a channel (cursor-based)
   */
  fastify.get('/api/internal/chat/channels/:channelId/messages', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;

    const { channelId } = request.params as { channelId: string };
    const { limit: limitStr, before, after } = request.query as {
      limit?: string;
      before?: string;
      after?: string;
    };

    const limit = Math.min(Math.max(parseInt(limitStr || '50', 10) || 50, 1), 200);

    const conditions = [eq(conversationHistory.channelId, channelId)];

    if (before) {
      conditions.push(lt(conversationHistory.createdAt, new Date(before)));
    }
    if (after) {
      conditions.push(gt(conversationHistory.createdAt, new Date(after)));
    }

    const messages = await db
      .select({
        id: conversationHistory.id,
        orgId: conversationHistory.orgId,
        channelId: conversationHistory.channelId,
        authorId: conversationHistory.authorId,
        authorName: conversationHistory.authorName,
        content: conversationHistory.content,
        isAgent: conversationHistory.isAgent,
        agentId: conversationHistory.agentId,
        createdAt: conversationHistory.createdAt,
      })
      .from(conversationHistory)
      .where(and(...conditions))
      .orderBy(desc(conversationHistory.createdAt))
      .limit(limit + 1); // Fetch one extra to determine hasMore

    const hasMore = messages.length > limit;
    const result = hasMore ? messages.slice(0, limit) : messages;

    // Return in chronological order
    result.reverse();

    return { messages: result, hasMore };
  });

  /**
   * GET /api/internal/chat/search
   * Full-text search across messages
   */
  fastify.get('/api/internal/chat/search', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;

    const {
      q,
      orgId,
      channelId,
      agentId,
      isAgent: isAgentStr,
      startDate,
      endDate,
      limit: limitStr,
      offset: offsetStr,
    } = request.query as {
      q?: string;
      orgId?: string;
      channelId?: string;
      agentId?: string;
      isAgent?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
      offset?: string;
    };

    if (!q || q.trim().length === 0) {
      return reply.status(400).send({ error: 'Search query (q) is required' });
    }

    const limit = Math.min(parseInt(limitStr || '50', 10) || 50, 200);
    const offset = parseInt(offsetStr || '0', 10) || 0;

    const conditions = [ilike(conversationHistory.content, `%${q}%`)];

    if (orgId) conditions.push(eq(conversationHistory.orgId, orgId));
    if (channelId) conditions.push(eq(conversationHistory.channelId, channelId));
    if (agentId) conditions.push(eq(conversationHistory.agentId, agentId));
    if (isAgentStr === 'true') conditions.push(eq(conversationHistory.isAgent, true));
    if (isAgentStr === 'false') conditions.push(eq(conversationHistory.isAgent, false));
    if (startDate) conditions.push(sql`${conversationHistory.createdAt} >= ${new Date(startDate)}`);
    if (endDate) conditions.push(sql`${conversationHistory.createdAt} <= ${new Date(endDate)}`);

    const [results, [totalRow]] = await Promise.all([
      db
        .select({
          id: conversationHistory.id,
          orgId: conversationHistory.orgId,
          channelId: conversationHistory.channelId,
          authorId: conversationHistory.authorId,
          authorName: conversationHistory.authorName,
          content: conversationHistory.content,
          isAgent: conversationHistory.isAgent,
          agentId: conversationHistory.agentId,
          createdAt: conversationHistory.createdAt,
        })
        .from(conversationHistory)
        .where(and(...conditions))
        .orderBy(desc(conversationHistory.createdAt))
        .limit(limit)
        .offset(offset),

      db
        .select({ count: count() })
        .from(conversationHistory)
        .where(and(...conditions)),
    ]);

    return { results, total: totalRow?.count ?? 0 };
  });

  /**
   * GET /api/internal/chat/analytics
   * Aggregate stats: message volume, top agents, top channels
   */
  fastify.get('/api/internal/chat/analytics', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;

    const { orgId, days: daysStr } = request.query as { orgId?: string; days?: string };
    const days = parseInt(daysStr || '30', 10) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const baseConditions = [sql`${conversationHistory.createdAt} >= ${since}`];
    if (orgId) baseConditions.push(eq(conversationHistory.orgId, orgId));

    const [
      [totals],
      messagesPerDay,
      topAgents,
      topChannels,
    ] = await Promise.all([
      // Total counts
      db
        .select({
          totalMessages: count(),
          agentMessages: sql<number>`COUNT(*) FILTER (WHERE ${conversationHistory.isAgent} = true)::int`,
          humanMessages: sql<number>`COUNT(*) FILTER (WHERE ${conversationHistory.isAgent} = false)::int`,
          uniqueChannels: sql<number>`COUNT(DISTINCT ${conversationHistory.channelId})::int`,
          activeOrgs: sql<number>`COUNT(DISTINCT ${conversationHistory.orgId})::int`,
        })
        .from(conversationHistory)
        .where(and(...baseConditions)),

      // Messages per day
      db
        .select({
          date: sql<string>`DATE(${conversationHistory.createdAt})::text`.as('date'),
          count: count(),
          agentCount: sql<number>`COUNT(*) FILTER (WHERE ${conversationHistory.isAgent} = true)::int`,
        })
        .from(conversationHistory)
        .where(and(...baseConditions))
        .groupBy(sql`DATE(${conversationHistory.createdAt})`)
        .orderBy(sql`DATE(${conversationHistory.createdAt})`),

      // Top agents by message count
      db
        .select({
          agentId: conversationHistory.agentId,
          messageCount: count(),
        })
        .from(conversationHistory)
        .where(and(...baseConditions, eq(conversationHistory.isAgent, true)))
        .groupBy(conversationHistory.agentId)
        .orderBy(desc(count()))
        .limit(10),

      // Most active channels
      db
        .select({
          channelId: conversationHistory.channelId,
          orgId: conversationHistory.orgId,
          messageCount: count(),
        })
        .from(conversationHistory)
        .where(and(...baseConditions))
        .groupBy(conversationHistory.channelId, conversationHistory.orgId)
        .orderBy(desc(count()))
        .limit(10),
    ]);

    return {
      totalMessages: totals?.totalMessages ?? 0,
      agentMessages: totals?.agentMessages ?? 0,
      humanMessages: totals?.humanMessages ?? 0,
      uniqueChannels: totals?.uniqueChannels ?? 0,
      activeOrgs: totals?.activeOrgs ?? 0,
      messagesPerDay: messagesPerDay.map((row) => ({
        ...row,
        date: (row.date as unknown) instanceof Date ? (row.date as unknown as Date).toISOString().slice(0, 10) : String(row.date),
      })),
      topAgents,
      topChannels,
    };
  });

  /**
   * GET /api/internal/chat/agents
   * List all agents with their persona info
   */
  fastify.get('/api/internal/chat/agents', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return;

    const allAgents = await db
      .select({
        id: agents.id,
        title: agents.title,
        version: agents.version,
      })
      .from(agents)
      .orderBy(agents.title);

    return { agents: allAgents };
  });
};
