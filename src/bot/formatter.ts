import { logger } from '../logger.js';
import { getCommunicationAdapter } from '../adapters/registry.js';

const MAX_SUGGESTIONS = 5;
const SUGGESTED_ACTIONS_RE = /<suggested-actions>([\s\S]*?)<\/suggested-actions>/i;

/**
 * Extract a <suggested-actions> block from agent response text.
 * Returns the cleaned body (block removed) and array of suggestion strings.
 * Caps suggestions at MAX_SUGGESTIONS to avoid cluttering the UI.
 */
export function parseSuggestedActions(text: string): { body: string; suggestions: string[] } {
  const match = text.match(SUGGESTED_ACTIONS_RE);
  if (!match) return { body: text, suggestions: [] };

  const suggestions = match[1]
    .split('\n')
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_SUGGESTIONS);

  const body = text.replace(SUGGESTED_ACTIONS_RE, '').trim();
  return { body, suggestions };
}

/** Prefix agent name and send via Comms Gateway */
export async function sendAgentMessage(
  targetId: string,
  agentTitle: string,
  content: string,
  orgId?: string,
): Promise<void> {
  const prefix = `**[${agentTitle}]** `;

  // Ensure target ID is unified format
  const unifiedId = targetId.includes(':') ? targetId : `discord:${targetId}`;

  // Determine if this is a channel target or a thread target.
  // Slack threads have 3+ parts: slack:channelId:threadTs
  // Slack channels have 2 parts: slack:channelId
  // Discord threads/channels are always: discord:id
  const isSlackChannelOnly = unifiedId.startsWith('slack:') && unifiedId.split(':').length === 2;
  const options = isSlackChannelOnly
    ? { channel_id: unifiedId, orgId }
    : { thread_id: unifiedId, orgId };

  const { body, suggestions } = parseSuggestedActions(content);
  const outbound: Parameters<ReturnType<typeof getCommunicationAdapter>['sendMessage']>[0] = {
    content: prefix + body,
  };
  if (suggestions.length > 0) {
    outbound.actionable_suggestions = suggestions;
  }

  const result = await getCommunicationAdapter().sendMessage(outbound, options);

  if (!result.success) {
    logger.error({ targetId, agentTitle, error: result.error }, 'Failed to send agent message via gateway');
  }
}

export function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to break at newline, then space
    let breakIdx = remaining.lastIndexOf('\n', maxLength);
    if (breakIdx === -1 || breakIdx < maxLength * 0.5) {
      breakIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (breakIdx === -1 || breakIdx < maxLength * 0.5) {
      breakIdx = maxLength;
    }

    chunks.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx).trimStart();
  }

  return chunks;
}
