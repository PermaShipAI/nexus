import { permashipConfig as config } from '../../adapters/permaship/config.js';
import { logger } from '../../logger.js';
import { randomUUID } from 'crypto';

export interface OutboundMessage {
  content?: string;
  embed_title?: string;
  embed_description?: string;
  embed_color?: number;
  components?: any[];
}

export interface SendMessageOptions {
  thread_id?: string;
  channel_id?: string;
  dm_user_id?: string;
  create_thread_title?: string;
}

/**
 * Communication Gateway for PermaShip Comms service.
 * Handles unified cross-platform messaging (Slack, Discord).
 */
export class CommunicationGateway {
  private static instance: CommunicationGateway;

  private constructor() {}

  public static getInstance(): CommunicationGateway {
    if (!CommunicationGateway.instance) {
      CommunicationGateway.instance = new CommunicationGateway();
    }
    return CommunicationGateway.instance;
  }

  /**
   * Send a message through the unified comms service.
   */
  public async sendMessage(
    message: OutboundMessage,
    options: SendMessageOptions & { orgId?: string }
  ): Promise<{ success: boolean; message_id?: string; thread_id?: string; error?: string }> {
    const url = `${config.COMMS_API_URL.replace(/\/+$/, '')}/v1/agent/messages`;
    const eventId = randomUUID();

    const body = {
      org_id: options.orgId || config.PERMASHIP_ORG_ID,
      project_id: '00000000-0000-0000-0000-000000000000',
      message,
      thread_id: options.thread_id,
      channel_id: options.channel_id,
      dm_user_id: options.dm_user_id,
      create_thread_title: options.create_thread_title,
    };

    logger.debug({ eventId, threadId: options.thread_id, channelId: options.channel_id, orgId: body.org_id }, 'Sending outbound gateway message');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': config.COMMS_SIGNING_SECRET || '',
          'X-Event-ID': eventId,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text, eventId }, 'Comms Gateway API error');
        return { success: false, error: `API error ${response.status}: ${text}` };
      }

      const result = await response.json() as { success: boolean; data: { message_id: string; thread_id?: string } };
      return { success: true, message_id: result.data.message_id, thread_id: result.data.thread_id };
    } catch (err) {
      logger.error({ err, eventId }, 'Failed to send message via Comms Gateway');
      return { success: false, error: (err as Error).message };
    }
  }
  /**
   * Add an emoji reaction to a message via the comms service.
   */
  public async addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    orgId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const url = `${config.COMMS_API_URL.replace(/\/+$/, '')}/v1/agent/reactions`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': config.COMMS_SIGNING_SECRET || '',
        },
        body: JSON.stringify({
          org_id: orgId || config.PERMASHIP_ORG_ID,
          project_id: '00000000-0000-0000-0000-000000000000',
          channel_id: channelId,
          message_id: messageId,
          emoji,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text }, 'Comms Gateway addReaction error');
        return { success: false, error: `API error ${response.status}: ${text}` };
      }

      return { success: true };
    } catch (err) {
      logger.error({ err }, 'Failed to add reaction via Comms Gateway');
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Rename a thread via the comms service.
   */
  public async renameThread(
    threadId: string,
    name: string,
    orgId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const url = `${config.COMMS_API_URL.replace(/\/+$/, '')}/v1/agent/threads/${encodeURIComponent(threadId)}`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': config.COMMS_SIGNING_SECRET || '',
        },
        body: JSON.stringify({ name, org_id: orgId || config.PERMASHIP_ORG_ID }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text }, 'Comms Gateway renameThread error');
        return { success: false, error: `API error ${response.status}: ${text}` };
      }

      return { success: true };
    } catch (err) {
      logger.error({ err }, 'Failed to rename thread via Comms Gateway');
      return { success: false, error: (err as Error).message };
    }
  }
}

export const comms = CommunicationGateway.getInstance();
