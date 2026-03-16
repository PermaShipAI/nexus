import { desc, eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationHistory, type NewConversationMessage } from '../db/schema.js';

export async function storeMessage(
  msg: Omit<NewConversationMessage, 'id' | 'createdAt'>,
): Promise<void> {
  await db.insert(conversationHistory).values(msg);
}

export async function getRecentMessages(
  channelId: string,
  orgId: string,
  limit = 20,
): Promise<Array<{ authorName: string; content: string; isAgent: boolean; agentId: string | null }>> {
  const rows = await db
    .select({
      authorName: conversationHistory.authorName,
      content: conversationHistory.content,
      isAgent: conversationHistory.isAgent,
      agentId: conversationHistory.agentId,
    })
    .from(conversationHistory)
    .where(and(
      eq(conversationHistory.channelId, channelId),
      eq(conversationHistory.orgId, orgId)
    ))
    .orderBy(desc(conversationHistory.createdAt))
    .limit(limit);

  // Return in chronological order
  return rows.reverse();
}
