import {
  Client,
  GatewayIntentBits,
  Message,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ChannelType,
} from 'discord.js';
import { routeIntent, RouterResult } from '../../intent/router.js';
import { getLinkedAccount } from '../../auth/account_linker.js';
import { RequestContext } from '../../rbac/types.js';
import { requestAdminApproval } from './autonomous-mode-gate.js';

const CONFIRMATION_TIMEOUT_MS = 60_000;
let cancellationCounter = 0;

export function getIntentConfirmationCancelledCount(): number {
  return cancellationCounter;
}

function getChannelType(message: Message): 'public' | 'private' | 'dm' {
  if (message.channel.type === ChannelType.DM) return 'dm';
  if (message.channel.type === ChannelType.GuildText) {
    const textChannel = message.channel as TextChannel;
    // Check if channel is NSFW or has no permissions set (public-ish heuristic)
    // In practice, inspect overwrites; here we use a simple permissionOverwrites check
    return textChannel.permissionOverwrites.cache.size === 0 ? 'public' : 'private';
  }
  return 'private';
}

export async function handleDiscordMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  const linkedAccount = getLinkedAccount('discord', message.author.id);
  const context: RequestContext = {
    platformUserId: message.author.id,
    platform: 'discord',
    channelType: getChannelType(message),
    role: linkedAccount?.role,
    messageId: message.id,
  };

  // Show ephemeral thinking indicator — Discord defers with ephemeral for slash commands.
  // For message-based interactions, use a temporary reaction.
  await message.react('⏳');

  let result: RouterResult;
  try {
    result = await routeIntent(message.content, context);
  } catch {
    await message.reactions.removeAll().catch(() => {});
    await message.reply('An unexpected error occurred. Please try again.');
    return;
  }

  // Remove thinking indicator
  await message.reactions.removeAll().catch(() => {});

  if (!result.allowed) {
    await message.reply(result.userMessage);
    return;
  }

  // Confirmation gate for state-mutating intents
  if (result.requiresConfirmation && result.intent) {
    if (result.intent.kind === 'ManageProject') {
      // ManageProject covers sensitive system settings (e.g. autonomous_mode).
      // Use the Admin/Owner-only HITL gate with a 5-minute fail-closed timeout.
      const settingKey =
        result.intent.params?.settingKey ??
        result.intent.params?.setting_key ??
        'project configuration';
      const actionDescription =
        Object.values(result.intent.params ?? {}).filter(Boolean).join(', ') ||
        'project configuration change';

      const approval = await requestAdminApproval(message, actionDescription, settingKey);
      if (!approval.approved) {
        return;
      }
    } else {
      // Standard confirm/cancel gate for other state-mutating intents (e.g. ProposeTask).
      const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('confirm')
          .setLabel('Confirm')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger),
      );

      const confirmMsg = await message.reply({
        content: `Are you sure you want to **${result.intent.kind}**? This action will modify system state.`,
        components: [confirmRow],
      });

      try {
        const interaction = await confirmMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: CONFIRMATION_TIMEOUT_MS,
          filter: (i) => i.user.id === message.author.id,
        });

        if (interaction.customId === 'cancel') {
          cancellationCounter++;
          await interaction.update({ content: 'Action cancelled.', components: [] });
          return;
        }

        await interaction.update({
          content: `Executing **${result.intent.kind}**...`,
          components: [],
        });
      } catch {
        // Timeout
        await confirmMsg
          .edit({ content: 'Confirmation timed out. Action cancelled.', components: [] })
          .catch(() => {});
        return;
      }
    }
  }

  // Dispatch to agent (placeholder — actual agent dispatch wired separately)
  await message.reply(
    `Intent recognized: **${result.intent?.kind}** (confidence: ${((result.intent?.confidenceScore ?? 0) * 100).toFixed(0)}%). Processing...`,
  );
}

/**
 * Handle admin_confirm and admin_cancel button interactions.
 * Returns true if the interaction was handled, false otherwise.
 */
export async function handleAdminButtonInteraction(
  customId: string,
  userId: string,
  replyFn: (content: string) => Promise<void>,
): Promise<boolean> {
  const { verifySignedCustomId } = await import('../../bot/interaction-crypto.js');
  const { setSetting } = await import('../../settings/service.js');

  if (customId.startsWith('admin_confirm:') || customId.startsWith('admin_cancel:')) {
    const verification = verifySignedCustomId(customId);
    if (!verification.valid) {
      await replyFn(`Action failed: invalid or expired confirmation token (${verification.reason}).`);
      return true;
    }

    if (customId.startsWith('admin_confirm:')) {
      const actionId = verification.actionId ?? '';
      const colonIdx = actionId.indexOf(':');
      if (colonIdx === -1) {
        await replyFn('Action failed: malformed action payload.');
        return true;
      }
      const settingKey = actionId.slice(0, colonIdx);
      const settingValue = actionId.slice(colonIdx + 1);
      if (!settingKey) {
        await replyFn('Action failed: empty setting key.');
        return true;
      }
      await setSetting(settingKey, settingValue, 'unknown', `discord:${userId}`);
      await replyFn(`Setting \`${settingKey}\` updated to \`${settingValue}\`.`);
    } else {
      await replyFn('Admin action cancelled.');
    }
    return true;
  }

  return false;
}

export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.on('messageCreate', (message) => {
    handleDiscordMessage(message).catch(console.error);
  });

  return client;
}
