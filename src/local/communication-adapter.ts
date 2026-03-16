import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  CommunicationAdapter,
  OutboundMessage,
  SendMessageOptions,
} from '../adapters/interfaces/communication-adapter.js';

/** Bus that the local WebSocket server listens to for outbound agent messages */
export const localBus = new EventEmitter();

/** Strip ANSI escape codes (color, cursor, etc.) from strings */
function stripAnsi(str: string | null | undefined): string | null {
  if (!str) return str as null;
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

export class LocalCommunicationAdapter implements CommunicationAdapter {
  async sendMessage(
    message: OutboundMessage,
    options: SendMessageOptions,
  ): Promise<{ success: boolean; message_id?: string; thread_id?: string; error?: string }> {
    const id = randomUUID();
    localBus.emit('message', {
      id,
      content: stripAnsi(message.content) ?? null,
      embed_title: stripAnsi(message.embed_title) ?? null,
      embed_description: stripAnsi(message.embed_description) ?? null,
      embed_color: message.embed_color ?? null,
      components: message.components ?? null,
      channel_id: options.thread_id ?? options.channel_id ?? null,
      timestamp: new Date().toISOString(),
    });
    return { success: true, message_id: id };
  }

  async addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ success: boolean; error?: string }> {
    localBus.emit('reaction', { channelId, messageId, emoji });
    return { success: true };
  }

  async renameThread(
    threadId: string,
    newName: string,
  ): Promise<{ success: boolean; error?: string }> {
    localBus.emit('thread_rename', { threadId, newName });
    return { success: true };
  }
}
