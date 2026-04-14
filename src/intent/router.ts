import { ClassifiedIntent } from '../../agents/schemas/intent.js';
import { RequestContext } from '../rbac/types.js';
import { classifyIntent } from './classifier.js';
import { checkPermission } from '../rbac/checker.js';
import { checkChannelSafety } from '../middleware/channel_safety.js';
import { logRoutingDecision } from './telemetry.js';
import { logGuardrailEvent } from '../telemetry/index.js';

export interface RouterResult {
  allowed: boolean;
  intent?: ClassifiedIntent;
  userMessage: string;
  requiresConfirmation?: boolean;
  blockReason?: string;
}

const CONFIRMATION_REQUIRED_INTENTS = ['ManageProject', 'ProposeTask', 'AccessSecrets', 'DestructiveAction', 'AdministrativeAction'];
const CLARIFICATION_MESSAGE =
  "I'm not sure what you'd like to do. Could you clarify?";
const TIMEOUT_MESSAGE =
  "Intent analysis timed out. Please try a `!command` directly.";

export async function routeIntent(
  message: string,
  context: RequestContext,
): Promise<RouterResult> {
  const startTime = Date.now();
  let intent: ClassifiedIntent;

  try {
    intent = await classifyIntent(message);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'TIMEOUT';
    const durationMs = Date.now() - startTime;
    logRoutingDecision({
      messageId: context.messageId,
      intentKind: 'Unknown',
      confidenceScore: 0,
      allowed: false,
      blockReason: isTimeout ? 'Timeout' : 'ClassificationError',
      channelType: context.channelType,
      platform: context.platform,
      durationMs,
      timestamp: new Date().toISOString(),
    });
    return {
      allowed: false,
      userMessage: TIMEOUT_MESSAGE,
      blockReason: isTimeout ? 'Timeout' : 'ClassificationError',
    };
  }

  const durationMs = Date.now() - startTime;

  // Low confidence — ask for clarification
  if (intent.confidenceScore < 0.6) {
    logRoutingDecision({
      messageId: context.messageId,
      intentKind: intent.kind,
      confidenceScore: intent.confidenceScore,
      allowed: false,
      blockReason: 'LowConfidence',
      channelType: context.channelType,
      platform: context.platform,
      durationMs,
      timestamp: new Date().toISOString(),
    });
    if (intent.kind === 'AdministrativeAction') {
      logGuardrailEvent({
        event: 'administrative_intent_clarification_triggered',
        intentKind: intent.kind,
        confidenceScore: intent.confidenceScore,
        channelId: '',
        userId: context.platformUserId,
        messageId: context.messageId,
      });
    }
    return {
      allowed: false,
      intent,
      userMessage: CLARIFICATION_MESSAGE,
      blockReason: 'LowConfidence',
    };
  }

  // Channel safety check (runs before RBAC)
  const safetyResult = checkChannelSafety(intent, context);
  if (safetyResult && !safetyResult.allowed) {
    logRoutingDecision({
      messageId: context.messageId,
      intentKind: intent.kind,
      confidenceScore: intent.confidenceScore,
      allowed: false,
      blockReason: 'PublicChannelRestriction',
      channelType: context.channelType,
      platform: context.platform,
      durationMs,
      timestamp: new Date().toISOString(),
    });
    return {
      allowed: false,
      intent,
      userMessage: safetyResult.userMessage ?? 'Action blocked.',
      blockReason: 'PublicChannelRestriction',
    };
  }

  // RBAC check
  const permResult = checkPermission(intent, context);
  if (!permResult.allowed) {
    logRoutingDecision({
      messageId: context.messageId,
      intentKind: intent.kind,
      confidenceScore: intent.confidenceScore,
      allowed: false,
      blockReason: permResult.reason,
      channelType: context.channelType,
      platform: context.platform,
      durationMs,
      timestamp: new Date().toISOString(),
    });
    return {
      allowed: false,
      intent,
      userMessage: permResult.userMessage ?? 'You do not have permission to perform this action.',
      blockReason: permResult.reason,
    };
  }

  // Confirmation gate for state-mutating intents
  const requiresConfirmation = CONFIRMATION_REQUIRED_INTENTS.includes(intent.kind);

  logRoutingDecision({
    messageId: context.messageId,
    intentKind: intent.kind,
    confidenceScore: intent.confidenceScore,
    allowed: true,
    channelType: context.channelType,
    platform: context.platform,
    durationMs,
    timestamp: new Date().toISOString(),
  });

  return {
    allowed: true,
    intent,
    userMessage: '',
    requiresConfirmation,
  };
}
