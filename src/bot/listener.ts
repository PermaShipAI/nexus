import { sendAgentMessage } from './formatter.js';
export { sendAgentMessage };
import { checkDestructiveAction } from '../core/guardrails/DestructiveActionGuard.js';
import { logGuardrailEvent } from '../telemetry/index.js';
import { getCommunicationAdapter } from '../adapters/registry.js';
import { storeMessage } from '../conversation/service.js';
import { logActivity } from '../idle/activity.js';
import { routeMessage } from '../router/index.js';
import type { RouteResult } from '../../agents/types/routing.js';
import { executeAgent } from '../agents/executor.js';
import { getAgent } from '../agents/registry.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { synthesizePublicReply } from './sanitizer.js';
import type { AgentResponse } from './sanitizer.js';

import { getQueuedSuggestions, markSuggestionsAsSent } from '../idle/service.js';
import { triggerIdleNow } from '../idle/timer.js';
import { AGENT_IDS, type AgentId } from '../agents/types.js';
import { db } from '../db/index.js';
import { pendingActions } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import {
  setSetting,
  isAutonomousMode,
  getPublicChannels,
  addPublicChannel,
  removePublicChannel,
  isPublicChannel,
  isNexusReportsEnabled,
} from '../settings/service.js';
import { getTenantResolver } from '../adapters/registry.js';

export interface UnifiedMessage {
  id: string;
  content: string;
  channelId: string;
  workspaceId: string; // guild_id or team_id
  authorId: string;
  authorName: string;
  isThread: boolean;
  parentId?: string;
  platform: 'discord' | 'slack';
  referenceId?: string;
  platformMessageId?: string; // Native platform message ID (Discord snowflake or Slack ts)
  orgId?: string; // Resolved from workspaceId
  enforceReadOnly?: boolean; // Advisory channels: no tickets, no proposals, no automated actions
  projectHint?: string; // Channel-mapped project name from comms
}

/**
 * Handle message from Comms Webhook
 */
export async function processWebhookMessage(unified: UnifiedMessage): Promise<void> {
  let context = await getTenantResolver().getContext(unified.platform, unified.workspaceId);

  // Auto-link workspace if comms sent a trusted org_id but no local link exists
  if (!context && unified.orgId) {
    logger.info({ orgId: unified.orgId, platform: unified.platform, workspaceId: unified.workspaceId }, 'Auto-linking workspace from comms webhook');
    const linkResult = await getTenantResolver().linkWorkspace(unified.orgId, unified.platform, unified.workspaceId, 'comms-auto', unified.channelId);
    if (linkResult.success) {
      context = await getTenantResolver().getContext(unified.platform, unified.workspaceId);
    }
  }

  if (!context) {
    logger.warn({ workspaceId: unified.workspaceId, platform: unified.platform }, 'Received message from unlinked workspace');

    // Frictionless setup: offer a connect link if shouldPrompt is true or mentioned
    const isMentioned = unified.content.includes('!activate');

    if (isMentioned || getTenantResolver().shouldPrompt(unified.platform, unified.workspaceId, unified.channelId)) {
      const activationBase = config.ACTIVATION_URL;
      const connectUrl = activationBase
        ? `${activationBase}/activate-agent?workspaceId=${unified.workspaceId}&platform=${unified.platform}&channelId=${unified.channelId}`
        : null;

      const connectMsg = connectUrl
        ? `To get started, please connect your organization:\n\n[Connect Organization](${connectUrl})`
        : `To get started, use the \`!activate <token>\` command with your activation token.`;

      await sendAgentMessage(unified.channelId, 'System',
        `Welcome to the Agent System!\n\n` +
        `This workspace is not yet connected to an organization. ` +
        `${connectMsg}`,
        unified.orgId,
      );
    }
    return;
  }
  
  const orgId = context.orgId;
  unified.orgId = orgId;

  // Strip platform prefix for comparison (webhook adds discord:/slack: prefix but DB may store bare IDs)
  const bareChannelId = unified.channelId.replace(/^(discord|slack):/, '');
  const bareParentId = unified.parentId?.replace(/^(discord|slack):/, '');

  const isInternalChannel = unified.channelId === context.internalChannelId
    || bareChannelId === context.internalChannelId
    || unified.channelId === config.DISCORD_CHANNEL_ID
    || bareChannelId === config.DISCORD_CHANNEL_ID;

  const isPublic = !isInternalChannel && await isPublicChannel(unified.channelId);

  // Proposal thread logic
  const isProposalThread = !isInternalChannel && !isPublic && unified.isThread
    && (unified.parentId === context.internalChannelId || bareParentId === context.internalChannelId
    || unified.parentId === config.DISCORD_CHANNEL_ID || bareParentId === config.DISCORD_CHANNEL_ID);

  // Allow !internal from any channel in a linked workspace (before the channel-type gate)
  if (unified.content.trim() === '!internal') {
    const res = await getTenantResolver().setInternalChannel(unified.platform, unified.workspaceId, unified.channelId);
    if (res.success) {
      await sendAgentMessage(unified.channelId, 'System', `✅ **Internal Control Channel Updated.** This channel is now the primary command center for Nexus reports and approvals.`, orgId);
    } else {
      await sendAgentMessage(unified.channelId, 'System', `❌ **Failed to update:** ${res.error}`, orgId);
    }
    return;
  }

  const isMissionChannel = unified.channelId.startsWith('mission:');
  // When comms forwards a message, the channel has already been validated on the comms side.
  // Only gate on channel type for directly-connected bots (no orgId from webhook).
  const isCommsForwarded = !!unified.orgId;
  if (!isCommsForwarded && !isInternalChannel && !isPublic && !isProposalThread && !isMissionChannel) return;

  // Fire-and-forget: acknowledge receipt with eyes emoji
  if (unified.platformMessageId) {
    getCommunicationAdapter().addReaction(unified.channelId, unified.platformMessageId, '👀', orgId).catch(err =>
      logger.warn({ err, messageId: unified.platformMessageId }, 'Failed to add acknowledgment reaction'),
    );
  }

  try {
    if (isInternalChannel && await handleAdminCommand(unified, orgId)) return;
    await handleIncomingMessage(unified, isPublic, orgId, unified.enforceReadOnly, unified.projectHint);
  } catch (err) {
    logger.error({ err, messageId: unified.id }, 'Error handling webhook message');
  }
}

export async function flushQueuedSuggestions(channelId: string, orgId: string): Promise<void> {
  const queued = await getQueuedSuggestions(orgId);
  if (queued.length === 0) return;

  logger.info({ count: queued.length, orgId }, 'Flushing queued suggestions');

  let batchMessage = '**Welcome back! While you were away, the agents identified the following items:**\n\n';

  queued.forEach((s, index) => {
    const agent = getAgent(s.agentId as any);
    batchMessage += `**Suggestion #${index + 1}** [${agent?.title ?? s.agentId}]\n${s.content}\n\n`;
  });

  batchMessage += '*To approve a ticket, reply with "Approve #1" or similar. You can also ask questions about specific items.*';

  await sendAgentMessage(channelId, 'System', batchMessage, orgId);
  await markSuggestionsAsSent(queued.map((q) => q.id));
}

import { orchestrateStrategy } from '../agents/strategy.js';

async function handleAdminCommand(message: UnifiedMessage, orgId: string): Promise<boolean> {
  const content = message.content.trim();
  const userName = message.authorName;

  // !autonomous on/off
  const autonomousMatch = content.match(/^!autonomous\s+(on|off)$/i);
  if (autonomousMatch) {
    const enabled = autonomousMatch[1].toLowerCase() === 'on';
    await setSetting('autonomous_mode', enabled, orgId, userName);
    await sendAgentMessage(message.channelId, 'System', `Autonomous mode **${enabled ? 'enabled' : 'disabled'}** for this organization by ${userName}.`, orgId);
    return true;
  }

  // !public off #channel
  const publicOffMatch = content.match(/^!public\s+off\s+(\S+)$/i);
  if (publicOffMatch) {
    const channelId = publicOffMatch[1].replace(/[<#>]/g, '');
    await removePublicChannel(channelId, orgId);
    await sendAgentMessage(message.channelId, 'System', `Public channel ${channelId} **unregistered** by ${userName}.`, orgId);
    return true;
  }

  // !public #channel
  const publicMatch = content.match(/^!public\s+(\S+)$/i);
  if (publicMatch) {
    const channelId = publicMatch[1].replace(/[<#>]/g, '');
    await addPublicChannel(channelId, orgId, userName);
    await sendAgentMessage(message.channelId, 'System', `Public channel ${channelId} **registered** by ${userName}.`, orgId);
    return true;
  }

  // !nexus-reports on/off
  const nexusReportsMatch = content.match(/^!nexus-reports\s+(on|off)$/i);
  if (nexusReportsMatch) {
    const enabled = nexusReportsMatch[1].toLowerCase() === 'on';
    await setSetting('nexus_reports', enabled, orgId, userName);
    await sendAgentMessage(message.channelId, 'System', `Nexus review cycle reports **${enabled ? 'enabled' : 'disabled'}** by ${userName}.`, orgId);
    return true;
  }

  // !modes
  if (content === '!modes') {
    const autonomous = await isAutonomousMode(orgId);
    const nexusReports = await isNexusReportsEnabled(orgId);
    const publicChannels = await getPublicChannels(orgId);
    
    // Find context for internal channel info
    const context = await getTenantResolver().getContext(message.platform, message.workspaceId);
    const internalChannelDisplay = context?.internalChannelId ? `<#${context.internalChannelId.replace(/.*:/, '')}>` : 'Unknown';

    const channelList = publicChannels.length > 0
      ? publicChannels.map((c) => `  - <#${c.channelId.replace(/.*:/, '')}>`).join('\n')
      : '  None';
    
    await sendAgentMessage(message.channelId, 'System',
      `**Current Configuration for Org \`${orgId}\`:**\n` +
      `- Internal Control Channel: ${internalChannelDisplay}\n` +
      `- Autonomous mode: **${autonomous ? 'ON' : 'OFF'}**\n` +
      `- Nexus reports: **${nexusReports ? 'ON' : 'OFF'}**\n` +
      `- Public channels:\n${channelList}`,
      orgId,
    );
    return true;
  }

  return false;
}

async function handleIncomingMessage(message: UnifiedMessage, isPublic: boolean, orgId: string, enforceReadOnly?: boolean, projectHint?: string): Promise<void> {
  const userName = message.authorName;

  // Handle !trigger command
  const triggerMatch = message.content.match(/^!trigger\s*(\S+)?/i);
  if (triggerMatch) {
    const requestedAgent = triggerMatch[1]?.toLowerCase();
    let agentId: AgentId | undefined;
    if (requestedAgent && AGENT_IDS.includes(requestedAgent as AgentId)) {
      agentId = requestedAgent as AgentId;
    }
    triggerIdleNow(orgId, message.channelId, agentId).catch((err) =>
      logger.error({ err, orgId }, 'Manual idle trigger failed'),
    );
    return;
  }

  const dashboardUrl = config.ACTIVATION_URL ? `${config.ACTIVATION_URL}/dashboard` : '';
  const destructiveCheck = checkDestructiveAction(message.content, dashboardUrl);
  if (destructiveCheck.blocked) {
    logGuardrailEvent({
      event: 'destructive_action_blocked',
      userId: message.authorId,
      channelId: message.channelId,
      orgId,
      matchedPattern: destructiveCheck.matchedPattern,
    });
    await sendAgentMessage(message.channelId, 'System', destructiveCheck.message, orgId);
    return;
  }

  // Store the incoming message
  await storeMessage({
    orgId,
    channelId: message.channelId,
    discordMessageId: message.id,
    authorId: message.authorId,
    authorName: userName,
    content: message.content,
    isAgent: false,
  });

  await logActivity('message', undefined, message.channelId, orgId);

  // Steering check
  let steeringContext = undefined;
  let targetAgentId: any = undefined;

  if (message.referenceId) {
    const [action] = await db.select().from(pendingActions).where(and(eq(pendingActions.orgId, orgId), eq(pendingActions.discordMessageId, message.referenceId))).limit(1);
    if (action && action.status === 'pending') {
      steeringContext = {
        originalActionId: action.id,
        previousProposal: action.description,
        userFeedback: message.content,
      };
      targetAgentId = action.agentId;
      await db.update(pendingActions).set({ status: 'superseded', resolvedAt: new Date() }).where(eq(pendingActions.id, action.id));
    }
  }

  if (!steeringContext && message.isThread) {
    const [action] = await db.select().from(pendingActions).where(and(eq(pendingActions.orgId, orgId), eq(pendingActions.channelId, message.channelId))).limit(1);
    if (action && action.status === 'pending') {
      steeringContext = {
        originalActionId: action.id,
        previousProposal: action.description,
        userFeedback: message.content,
      };
      targetAgentId = action.agentId;
      await db.update(pendingActions).set({ status: 'superseded', resolvedAt: new Date() }).where(eq(pendingActions.id, action.id));
    }
  }

  const routes: RouteResult[] = steeringContext && targetAgentId
    ? [{ agentId: targetAgentId, intent: 'steering', subMessage: message.content, confidenceScore: 1.0, reasoning: 'steering', extractedEntities: {}, needsCodeAccess: true, isStrategySession: false, isFallback: false }]
    : await routeMessage(message.content, message.channelId, userName, orgId);
  
  const strategyRoute = routes.find((r) => r.isStrategySession);
  if (strategyRoute) {
    const strategyResponse = await orchestrateStrategy({
      orgId,
      goal: message.content,
      channelId: message.channelId,
      userId: message.authorId,
      userName,
    });
    await sendAgentMessage(message.channelId, 'Strategy Coordinator', strategyResponse, orgId);
    return;
  }

  const publicResponses: AgentResponse[] = [];

  // If router returned no valid agent, fall back to nexus
  const hasValidAgent = routes.some(r => getAgent(r.agentId as AgentId));
  const effectiveRoutes: RouteResult[] = hasValidAgent
    ? routes
    : [{ agentId: 'nexus' as const, intent: 'fallback', subMessage: message.content, confidenceScore: 0.5, reasoning: 'No agent matched, falling back to nexus', extractedEntities: {}, needsCodeAccess: false, isStrategySession: false, isFallback: true }];

  for (const route of effectiveRoutes) {
    const agent = getAgent(route.agentId as AgentId);
    if (!agent) continue;

    await isAutonomousMode(orgId);

    const response = await executeAgent({
      orgId,
      agentId: route.agentId as AgentId,
      channelId: message.channelId,
      userId: message.authorId,
      userName,
      userMessage: route.subMessage,
      needsCodeAccess: route.needsCodeAccess,
      needsDeepResearch: route.needsDeepResearch,
      source: 'user',
      steering: steeringContext,
      isStrictConsultation: enforceReadOnly || route.isStrictConsultation || false,
      projectHint,
      // Approval messages are sent by the Nexus scheduler after review,
      // not here — sending here would show buttons before the agent's
      // response text and before Nexus has reviewed the proposal.
    });

    if (!response) continue;

    // If the agent hit an unrecoverable error (e.g. LLM failure), notify the user
    if (response === '[error]') {
      await sendAgentMessage(message.channelId, agent.title,
        `I ran into a temporary issue processing your request. Please try again in a moment.`, orgId);
      continue;
    }

    if (isPublic) {
      publicResponses.push({ agentTitle: agent.title, agentId: route.agentId as AgentId, content: response });
    } else {
      await sendAgentMessage(message.channelId, agent.title, response, orgId);

      await storeMessage({
        orgId,
        channelId: message.channelId,
        discordMessageId: `${message.id}-${route.agentId}`,
        authorId: 'agent',
        authorName: agent.title,
        content: response,
        isAgent: true,
        agentId: route.agentId as AgentId,
      });

      await logActivity('agent_response', route.agentId as AgentId, message.channelId, orgId);
    }
  }

  if (isPublic && publicResponses.length > 0) {
    const synthesized = await synthesizePublicReply(message.content, publicResponses);
    const teamLabel = `${await getTenantResolver().getOrgName(orgId)} Team`;

    if (synthesized && synthesized !== '[internal update]') {
      await sendAgentMessage(message.channelId, teamLabel, synthesized, orgId);

      await storeMessage({
        orgId,
        channelId: message.channelId,
        discordMessageId: `${message.id}-synthesized`,
        authorId: 'agent',
        authorName: teamLabel,
        content: synthesized,
        isAgent: true,
      });
    }

    for (const r of publicResponses) {
      await logActivity('agent_response', r.agentId as any, message.channelId, orgId);
    }
  }
}
