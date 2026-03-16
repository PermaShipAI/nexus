import { randomUUID } from 'node:crypto';
import { executeAgent } from './executor.js';
import { getAgent, getAllAgents } from './registry.js';
import { logger } from '../logger.js';
import type { AgentId } from './types.js';
import { getLLMProvider } from '../adapters/registry.js';

export interface StrategySessionInput {
  orgId: string;
  goal: string;
  channelId: string;
  userId: string;
  userName: string;
}

export async function orchestrateStrategy(input: StrategySessionInput): Promise<string> {
  const { orgId, goal, channelId } = input;
  const strategyId = randomUUID();
  
  logger.info({ orgId, goal, strategyId }, 'Starting multi-agent strategy session');

  // 1. Identify participating agents
  const agents = getAllAgents();
  const agentList = agents.map(a => `- ${a.id}: ${a.title} (${a.summary})`).join('\n');
  const selectionPrompt = `
You are the Strategy Coordinator. A user has proposed a high-level goal:
"${goal}"

Available Agents:
${agentList}

Identify which 2-4 agents are MOST CRITICAL to collaborate on a plan for this goal.
Respond with a JSON array of agent IDs. Example: ["sre", "ciso", "product-manager"]
`.trim();

  const selectionResponse = await getLLMProvider().generateText({
    model: 'ROUTER',
    contents: [{ role: 'user', parts: [{ text: selectionPrompt }] }],
  });

  let selectedAgentIds: AgentId[] = [];
  try {
    const cleaned = selectionResponse.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    selectedAgentIds = JSON.parse(cleaned);
  } catch (err) {
    logger.error({ err, response: selectionResponse }, 'Failed to parse agent selection');
    selectedAgentIds = ['product-manager', 'sre'] as AgentId[];
  }

  // 2. Gather input from each agent
  const contributions: string[] = [];
  
  for (const agentId of selectedAgentIds) {
    const agent = getAgent(agentId);
    if (!agent) continue;
    
    const contributionPrompt = `
You are participating in a Strategy Session for the following goal:
"${goal}"

From your perspective as ${agent.title}, what are the specific tasks, risks, or requirements we must address?
Provide a concise list of actionable items.
`.trim();

    const response = await executeAgent({
      orgId,
      agentId,
      channelId,
      userId: 'system',
      userName: 'Strategy Coordinator',
      userMessage: contributionPrompt,
      needsCodeAccess: false,
      source: 'user',
    });
    
    if (response) {
      contributions.push(`### ${agent.title}\n${response}`);
    }
  }

  // 3. Synthesize into a unified plan via the CTO agent
  const contributionText = contributions.join('\n\n');

  const plan = await executeAgent({
    orgId,
    agentId: 'nexus' as AgentId,
    channelId,
    userId: 'system',
    userName: 'Strategy Session',
    userMessage: `Synthesize these agent contributions into a prioritized execution plan for the goal: "${goal}"

Agent Contributions:
${contributionText}

Create a coherent, step-by-step plan. For each step, indicate which agent should be the primary owner. Prioritize by impact and risk. Identify dependencies between steps. Respond in Markdown.`,
    needsCodeAccess: false,
    source: 'user',
  });

  return `## Strategy Session: ${goal}\n\n${plan ?? 'No synthesis produced.'}\n\n*Strategy ID: ${strategyId}*`;
}
