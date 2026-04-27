import { db } from '../db/index.js';
import { pendingActions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import { parseArgs } from '../utils/parse-args.js';
import { getPublicChannels } from '../settings/service.js';
import { getCommunicationAdapter } from '../adapters/registry.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildSignedCustomId } from './interaction-crypto.js';

export async function sendApprovalMessage(
  channelId: string,
  agentTitle: string,
  actionId: string,
  description: string,
  orgId?: string,
): Promise<void> {
  // Fetch full action details from DB
  const [action] = await db
    .select()
    .from(pendingActions)
    .where(eq(pendingActions.id, actionId))
    .limit(1);

  const args = parseArgs(action?.args);

  let details = '';
  if (args.title) details += `**Title:** ${args.title}\n`;
  if (args.kind) details += `**Kind:** ${args.kind}\n`;
  if (args.project || args['project-id']) details += `**Project:** ${args.project ?? args['project-id']}\n`;
  if (args['repo-key']) details += `**Repo:** ${args['repo-key']}\n`;
  if (args.priority) details += `**Priority:** ${args.priority}\n`;
  if (args.description) details += `**Description:** ${args.description}\n`;
  if (args.ctoDecisionReason) details += `**Nexus Rationale:** ${args.ctoDecisionReason}\n`;

  const isNexusAgent = action?.agentId === 'nexus';
  const header = isNexusAgent
    ? `**Human Approval Required** — Agent **${agentTitle}**\n${description}`
    : `**Nexus-Reviewed Proposal** — Agent **${agentTitle}**\n${description}`;

  // Discord content limit is 2000 chars; put details in embed_description instead
  const content = header.length > 1900 ? header.slice(0, 1897) + '...' : header;
  // Embed description limit is 4096 chars
  const embedDescription = details.length > 4096 ? details.slice(0, 4093) + '...' : details;
  const unifiedChannelId = channelId.includes(':') ? channelId : `discord:${channelId}`;

  const threadTitle = (args.title as string) || description || 'Proposal Review';

  const result = await getCommunicationAdapter().sendMessage({
    content,
    embed_title: (args.title as string) || 'Proposal Review',
    embed_description: embedDescription || undefined,
    components: [
      {
        type: 'button',
        custom_id: buildSignedCustomId('approve_tool', actionId),
        label: 'Approve',
        style: 'success'
      },
      {
        type: 'button',
        custom_id: buildSignedCustomId('reject_tool', actionId),
        label: 'Reject',
        style: 'danger'
      }
    ]
  }, {
    channel_id: unifiedChannelId,
    create_thread_title: threadTitle,
    orgId: orgId || action?.orgId,
  });

  if (result.success && result.message_id) {
    await db.update(pendingActions)
      .set({ discordMessageId: result.message_id, channelId: unifiedChannelId })
      .where(eq(pendingActions.id, actionId));
  } else {
    logger.error({ actionId, error: result.error }, 'Failed to send approval message via gateway');
  }
}

export async function sendAutonomousNotification(
  channelId: string,
  agentTitle: string,
  actionId: string,
  ticketResult: { success: boolean; ticketId?: string; error?: string },
  orgId?: string,
): Promise<void> {
  const [action] = await db
    .select()
    .from(pendingActions)
    .where(eq(pendingActions.id, actionId))
    .limit(1);

  const args = parseArgs(action?.args);

  let details = '';
  if (args.title) details += `**Title:** ${args.title}\n`;
  if (args.kind) details += `**Kind:** ${args.kind}\n`;
  if (args.project || args['project-id']) details += `**Project:** ${args.project ?? args['project-id']}\n`;
  if (args['repo-key']) details += `**Repo:** ${args['repo-key']}\n`;
  if (args.priority) details += `**Priority:** ${args.priority}\n`;
  if (args.description) details += `**Description:** ${args.description}\n`;
  if (args.ctoDecisionReason) details += `**Nexus Rationale:** ${args.ctoDecisionReason}\n`;

  const outcome = ticketResult.success
    ? `Ticket auto-created: \`${ticketResult.ticketId}\``
    : `Ticket creation failed — retrying in background...`;

  const header = `**[Autonomous Mode]** — Agent **${agentTitle}**\n${outcome}`;
  const content = header.length > 1900 ? header.slice(0, 1897) + '...' : header;
  const unifiedId = channelId.includes(':') ? channelId : `discord:${channelId}`;

  // Slack channel-only IDs (slack:channelId) must use channel_id, not thread_id
  const isSlackChannelOnly = unifiedId.startsWith('slack:') && unifiedId.split(':').length === 2;
  const options = isSlackChannelOnly
    ? { channel_id: unifiedId }
    : { thread_id: unifiedId };

  const embedDescription = details.length > 4096 ? details.slice(0, 4093) + '...' : details;
  const result = await getCommunicationAdapter().sendMessage({ content, embed_description: embedDescription || undefined }, { ...options, orgId: orgId || action?.orgId });

  if (result.success && result.message_id) {
    await db.update(pendingActions)
      .set({ discordMessageId: result.message_id, channelId: unifiedId })
      .where(eq(pendingActions.id, actionId));
  }
}

export async function sendHumanGateBlockedNotification(
  channelId: string,
  ticketId: string,
  approvalUrl: string,
  agentTitle?: string,
): Promise<void> {
  const unifiedChannelId = channelId.includes(':') ? channelId : `discord:${channelId}`;
  try {
    const embed = new EmbedBuilder()
      .setTitle('⏸ Task Paused: Manual Review Required')
      .setColor(0xFFA500)
      .setDescription(
        'This task is paused pending mandatory human review. An agent attempted to advance its state but has been blocked.',
      );

    if (agentTitle) {
      embed.addFields({ name: 'Agent', value: agentTitle, inline: true });
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel('Review in Conductor')
        .setStyle(ButtonStyle.Link)
        .setURL(approvalUrl),
    );

    const result = await getCommunicationAdapter().sendMessage(
      {
        embed_title: '⏸ Task Paused: Manual Review Required',
        embed_description:
          'This task is paused pending mandatory human review. An agent attempted to advance its state but has been blocked.',
        components: [
          {
            type: 'button',
            label: 'Review in Conductor',
            style: 'link',
            url: approvalUrl,
          },
        ],
      },
      { channel_id: unifiedChannelId },
    );

    // Suppress unused variable warnings for embed/row — kept for documentation of intended discord.js shape
    void embed;
    void row;

    if (!result.success) {
      logger.error({ ticketId, error: result.error }, 'sendHumanGateBlockedNotification: embed send failed, falling back to plain-text');
      throw new Error(result.error ?? 'send failed');
    }
  } catch (err) {
    try {
      logger.error({ ticketId, err }, 'sendHumanGateBlockedNotification: falling back to plain-text');
      await getCommunicationAdapter().sendMessage(
        { content: `⏸ Task paused pending human review. Approve at: ${approvalUrl} — Ticket: ${ticketId}` },
        { channel_id: unifiedChannelId },
      );
    } catch (fallbackErr) {
      logger.error({ ticketId, fallbackErr }, 'sendHumanGateBlockedNotification: plain-text fallback also failed');
    }
  }
}

export async function sendPublicChannelAlerts(
  kind: string,
  title: string,
  orgId: string,
): Promise<void> {
  const publicChannels = await getPublicChannels(orgId);
  if (publicChannels.length === 0) return;

  const alertMessage = `**Update** — A new ${kind} ticket has been created: "${title}". A fix/feature will be included in an upcoming release.`;

  for (const entry of publicChannels) {
    const unifiedId = entry.channelId.includes(':') ? entry.channelId : `discord:${entry.channelId}`;
    await getCommunicationAdapter().sendMessage({ content: alertMessage }, { channel_id: unifiedId, orgId });
  }
}
