// @ts-expect-error -- @slack/bolt types not installed yet
import { App, GenericMessageEvent } from '@slack/bolt';
import { routeIntent, RouterResult } from '../../intent/router.js';
import { getLinkedAccount } from '../../auth/account_linker.js';
import { RequestContext } from '../../rbac/types.js';

let cancellationCounter = 0;

export function getIntentConfirmationCancelledCount(): number {
  return cancellationCounter;
}

const CONFIRMATION_TIMEOUT_MS = 60_000;

function getChannelType(channelId: string): 'public' | 'private' | 'dm' {
  // Slack channel ID conventions:
  // C... = public channel, G... = private group/channel, D... = DM
  if (channelId.startsWith('D')) return 'dm';
  if (channelId.startsWith('G')) return 'private';
  return 'public';
}

export async function handleSlackMessage(
  message: GenericMessageEvent,
  client: App['client'],
): Promise<void> {
  const userId = message.user;
  const channelId = message.channel;

  if (!userId || !channelId) return;

  const linkedAccount = getLinkedAccount('slack', userId);
  const context: RequestContext = {
    platformUserId: userId,
    platform: 'slack',
    channelType: getChannelType(channelId),
    role: linkedAccount?.role,
    messageId: message.ts,
  };

  // Post ephemeral thinking indicator
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: '⏳ Analyzing your request...',
  });

  let result: RouterResult;
  try {
    result = await routeIntent(message.text ?? '', context);
  } catch {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: 'An unexpected error occurred. Please try again.',
    });
    return;
  }

  if (!result.allowed) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: result.userMessage,
    });
    return;
  }

  // Confirmation gate for state-mutating intents
  if (result.requiresConfirmation && result.intent) {
    const pendingActions = new Map<string, ReturnType<typeof setTimeout>>();

    await client.chat.postMessage({
      channel: channelId,
      text: `Are you sure you want to **${result.intent.kind}**?`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Are you sure you want to *${result.intent.kind}*? This action will modify system state.`,
          },
        },
        {
          type: 'actions',
          block_id: `confirm_${context.messageId}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Confirm' },
              action_id: `confirm_action_${context.messageId}`,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Cancel' },
              action_id: `cancel_action_${context.messageId}`,
              style: 'danger',
            },
          ],
        },
      ],
    });

    // Timeout cleanup
    const timeoutId = setTimeout(() => {
      pendingActions.delete(context.messageId);
    }, CONFIRMATION_TIMEOUT_MS);

    pendingActions.set(context.messageId, timeoutId);
    return; // Response handled by block_actions handler
  }

  // Dispatch to agent
  await client.chat.postMessage({
    channel: channelId,
    text: `Intent recognized: *${result.intent?.kind}* (confidence: ${((result.intent?.confidenceScore ?? 0) * 100).toFixed(0)}%). Processing...`,
  });
}

export function createSlackApp(signingSecret: string, botToken: string): App {
  const app = new App({
    signingSecret,
    token: botToken,
  });

  app.message(async ({ message, client }: any) => {
    if (message.subtype) return; // Skip bot messages, edits, etc.
    await handleSlackMessage(message as GenericMessageEvent, client);
  });

  app.action(/^confirm_action_/, async ({ ack, body, client }: any) => {
    await ack();
    const channelId = (body as any).channel?.id;
    const userId = body.user.id;
    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Action confirmed by <@${userId}>. Executing...`,
      });
    }
  });

  app.action(/^cancel_action_/, async ({ ack, body, client }: any) => {
    await ack();
    cancellationCounter++;
    const channelId = (body as any).channel?.id;
    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'Action cancelled.',
      });
    }
  });

  return app;
}
