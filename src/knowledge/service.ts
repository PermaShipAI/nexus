import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { knowledgeEntries, type KnowledgeEntry } from '../db/schema.js';
import { getLLMProvider } from '../adapters/registry.js';
import type { AgentId } from '../agents/types.js';

export async function addSharedKnowledge(
  orgId: string,
  topic: string,
  content: string,
): Promise<KnowledgeEntry> {
  const embedding = await getLLMProvider().embedText(`${topic}: ${content}`);
  const [entry] = await db
    .insert(knowledgeEntries)
    .values({ orgId, kind: 'shared', topic, content, embedding })
    .returning();
  return entry;
}

export async function addAgentMemory(
  orgId: string,
  agentId: AgentId,
  topic: string,
  content: string,
): Promise<KnowledgeEntry> {
  const embedding = await getLLMProvider().embedText(`${topic}: ${content}`);
  const [entry] = await db
    .insert(knowledgeEntries)
    .values({ orgId, kind: 'agent_memory', agentId, topic, content, embedding })
    .returning();
  return entry;
}

export async function queryKnowledge(
  orgId: string,
  query: string,
  agentId?: AgentId,
  limit = 5,
): Promise<KnowledgeEntry[]> {
  const queryEmbedding = await getLLMProvider().embedText(query);
  
  const pattern = `%${query}%`;

  const results = await db
    .select()
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.orgId, orgId),
        agentId 
          ? sql`(${knowledgeEntries.kind} = 'shared' OR (${knowledgeEntries.kind} = 'agent_memory' AND ${knowledgeEntries.agentId} = ${agentId}))`
          : eq(knowledgeEntries.kind, 'shared'),
        sql`${knowledgeEntries.content} ILIKE ${pattern} OR ${knowledgeEntries.topic} ILIKE ${pattern}`
      )
    )
    .limit(20);

  // Rerank results in memory using cosine similarity if embeddings exist and we have a query embedding
  if (queryEmbedding && results.length > 0) {
    const dotProduct = (a: number[], b: number[]) => a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magnitude = (a: number[]) => Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const similarity = (a: number[], b: number[]) => dotProduct(a, b) / (magnitude(a) * magnitude(b));

    return results
      .sort((a, b) => {
        if (!a.embedding || !b.embedding) return 0;
        return similarity(b.embedding, queryEmbedding) - similarity(a.embedding, queryEmbedding);
      })
      .slice(0, limit);
  }

  return results.slice(0, limit);
}

export async function getAgentMemories(agentId: AgentId, orgId: string): Promise<KnowledgeEntry[]> {
  return db
    .select()
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.orgId, orgId),
        eq(knowledgeEntries.kind, 'agent_memory'),
        eq(knowledgeEntries.agentId, agentId),
      ),
    );
}

export async function getSharedKnowledge(orgId: string): Promise<KnowledgeEntry[]> {
  return db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.orgId, orgId), eq(knowledgeEntries.kind, 'shared')));
}
