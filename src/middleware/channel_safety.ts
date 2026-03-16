import { ClassifiedIntent, IntentKind } from '../../agents/schemas/intent.js';
import { RequestContext, PermissionResult } from '../rbac/types.js';

const PUBLIC_CHANNEL_BLOCKED_INTENTS: IntentKind[] = ['ManageProject', 'AccessSecrets'];

export function checkChannelSafety(
  intent: ClassifiedIntent,
  context: RequestContext,
): PermissionResult | null {
  if (context.channelType !== 'public') {
    return null; // No restriction in private channels or DMs
  }

  if (PUBLIC_CHANNEL_BLOCKED_INTENTS.includes(intent.kind)) {
    return {
      allowed: false,
      reason: 'PublicChannelRestriction',
      userMessage:
        'This action is not permitted in public channels. Please use a private channel or DM.',
    };
  }

  // Block intents with sensitive params even if intent kind is allowed
  if (intent.params.deleteTarget || intent.params.secretName) {
    return {
      allowed: false,
      reason: 'PublicChannelRestriction',
      userMessage:
        'This action is not permitted in public channels. Please use a private channel or DM.',
    };
  }

  return null; // Allowed
}
