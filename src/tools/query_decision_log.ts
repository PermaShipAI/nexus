import { db } from '../db/index.js';
import { activityLog } from '../db/schema.js';
import { desc, sql } from 'drizzle-orm';

/**
 * Query the decision / activity log for entries matching a search term.
 * Returns the most recent matching entries (up to 25).
 */
export async function queryDecisionLog(query: string): Promise<{
  entries: Array<{
    id: string;
    kind: string;
    agentId: string | null;
    channelId: string | null;
    metadata: unknown;
    createdAt: Date;
  }>;
  count: number;
}> {
  const pattern = `%${query}%`;

  const entries = await db
    .select()
    .from(activityLog)
    .where(
      sql`(${activityLog.kind} ILIKE ${pattern}
        OR ${activityLog.agentId} ILIKE ${pattern}
        OR CAST(${activityLog.metadata} AS TEXT) ILIKE ${pattern})`,
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(25);

  return { entries, count: entries.length };
}
