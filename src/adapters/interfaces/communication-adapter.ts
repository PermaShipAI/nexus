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
  orgId?: string;
}

export interface CommunicationAdapter {
  sendMessage(
    message: OutboundMessage,
    options: SendMessageOptions,
  ): Promise<{ success: boolean; message_id?: string; thread_id?: string; error?: string }>;

  addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    orgId?: string,
  ): Promise<{ success: boolean; error?: string }>;

  renameThread(
    threadId: string,
    newName: string,
    orgId?: string,
  ): Promise<{ success: boolean; error?: string }>;
}
