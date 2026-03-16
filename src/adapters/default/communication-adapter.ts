import type {
  CommunicationAdapter,
  OutboundMessage,
  SendMessageOptions,
} from '../interfaces/communication-adapter.js';

/**
 * Console-based communication adapter for development and standalone use.
 * Logs messages to stdout instead of sending them to an external service.
 */
export class ConsoleCommunicationAdapter implements CommunicationAdapter {
  async sendMessage(
    message: OutboundMessage,
    options: SendMessageOptions,
  ): Promise<{ success: boolean; message_id?: string; thread_id?: string }> {
    const target = options.thread_id ?? options.channel_id ?? options.dm_user_id ?? 'unknown';
    const content = message.content ?? message.embed_description ?? '';
    const title = message.embed_title ? `[${message.embed_title}] ` : '';
    console.log(`[MSG → ${target}] ${title}${content}`);
    return { success: true, message_id: `console-${Date.now()}` };
  }

  async addReaction(
    _channelId: string,
    _messageId: string,
    emoji: string,
  ): Promise<{ success: boolean }> {
    console.log(`[REACT] ${emoji}`);
    return { success: true };
  }

  async renameThread(
    threadId: string,
    newName: string,
  ): Promise<{ success: boolean }> {
    console.log(`[THREAD ${threadId}] renamed → ${newName}`);
    return { success: true };
  }
}
