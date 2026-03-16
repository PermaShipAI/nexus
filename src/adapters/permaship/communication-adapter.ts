import { comms } from '../../services/communication/gateway.js';
import type {
  CommunicationAdapter,
  OutboundMessage,
  SendMessageOptions,
} from '../interfaces/communication-adapter.js';

export class PermashipCommunicationAdapter implements CommunicationAdapter {
  async sendMessage(
    message: OutboundMessage,
    options: SendMessageOptions,
  ): Promise<{ success: boolean; message_id?: string; thread_id?: string; error?: string }> {
    return comms.sendMessage(message, options);
  }

  async addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    orgId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    return comms.addReaction(channelId, messageId, emoji, orgId);
  }

  async renameThread(
    threadId: string,
    newName: string,
    orgId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    return comms.renameThread(threadId, newName, orgId);
  }
}
