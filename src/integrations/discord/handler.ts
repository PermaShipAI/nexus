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
import { RequestContext, Role } from '../../rbac/types.js';
import { requestAdminApproval } from './autonomous-mode-gate.js';
import { logGuardrailEvent } from '../../telemetry/index.js';

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
    } else if (result.intent.kind === 'AdministrativeAction') {
      // Admin-only confirmation gate for system-level setting changes.
      const ADMIN_ROLES: Role[] = ['ADMIN', 'OWNER'];
      const settingKey = result.intent.params?.settingKey ?? result.intent.params?.setting_key ?? 'unknown';
      const settingValue = result.intent.params?.settingValue ?? result.intent.params?.setting_value ?? 'unknown';

      logGuardrailEvent({
        event: 'administrative_intent_clarification_triggered',
        channelId: message.channelId,
        userId: message.author.id,
        settingKey,
        settingValue,
      });

      const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('admin_confirm')
          .setLabel('Confirm')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('admin_cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger),
      );

      const confirmMsg = await message.reply({
        content: `Are you sure you want to change system setting: **${settingKey}** → **${settingValue}**?\nOnly you (as an admin) can confirm this action.`,
        components: [confirmRow],
      });

      try {
        const interaction = await confirmMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: CONFIRMATION_TIMEOUT_MS,
          filter: (i) => {
            const account = getLinkedAccount('discord', i.user.id);
            const isAdmin = account !== null && ADMIN_ROLES.includes(account.role);
            const isRequester = i.user.id === message.author.id;
            if (!isRequester || !isAdmin) {
              i.reply({
                content: 'Only the original requester with Admin role can confirm this.',
                ephemeral: true,
              }).catch(() => {});
              return false;
            }
            return true;
          },
        });

        if (interaction.customId === 'admin_cancel') {
          cancellationCounter++;
          await interaction.update({ content: 'Action cancelled.', components: [] });
          return;
        }

        await interaction.update({ content: '✅ Confirmed — executing...', components: [] });
      } catch {
        // Timeout
        await confirmMsg
          .edit({ content: 'Confirmation timed out. Action cancelled.', components: [] })
          .catch(() => {});
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
