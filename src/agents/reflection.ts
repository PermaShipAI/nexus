import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agents, pendingActions } from '../db/schema.js';
import { getLLMProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';
import type { AgentId } from './types.js';

export async function reflectAndEvolve(agentId: AgentId): Promise<void> {
  logger.info({ agentId }, 'Starting persona reflection');

  // 1. Fetch recent activity and feedback
  const recentActions = await db
    .select()
    .from(pendingActions)
    .where(eq(pendingActions.agentId, agentId))
    .orderBy(desc(pendingActions.createdAt))
    .limit(10);

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return;

  const successful = recentActions.filter(a => a.status === 'approved').map(a => a.description).join('\n');
  const rejected = recentActions.filter(a => a.status === 'rejected').map(a => a.description).join('\n');

  if (recentActions.length < 3) {
    logger.info({ agentId }, 'Not enough actions to reflect');
    return;
  }

  // 2. Ask Gemini to analyze patterns
  const reflectionPrompt = `
You are an AI Meta-Strategist. Analyze the performance of the ${agent.title} agent.

Existing Persona:
${agent.personaMd.slice(0, 1000)}...

Recent Approved Actions (The team liked these):
${successful || 'None yet'}

Recent Rejected Actions (The team did NOT like these):
${rejected || 'None yet'}

Identify 2-3 specific "Lessons Learned" or "Style Adjustments" for this agent to better serve the team's preferences.
Respond with a concise markdown section titled "## Evolution & Lessons Learned".
`.trim();

  const evolution = await getLLMProvider().generateText({
    model: 'WORK',
    contents: [{ role: 'user', parts: [{ text: reflectionPrompt }] }],
  });

  // 3. Update agent persona in DB
  // We append the evolution to the persona so it carries forward
  const updatedPersona = `${agent.personaMd}

${evolution}`;
  
  await db.update(agents)
    .set({ personaMd: updatedPersona, updatedAt: new Date() })
    .where(eq(agents.id, agentId));

  logger.info({ agentId }, 'Persona evolved with new lessons');
}
