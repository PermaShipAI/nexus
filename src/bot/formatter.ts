import { logger } from '../logger.js';
import { getCommunicationAdapter } from '../adapters/registry.js';

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

  const result = await getCommunicationAdapter().sendMessage(
    { content: prefix + content },
    options,
  );

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
