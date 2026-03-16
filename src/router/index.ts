import { queryKnowledge } from '../knowledge/service.js';
import { getLLMProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';
import { logRoutingDecision } from '../../agents/telemetry/logger.js';
import type { RouteResult } from '../../agents/types/routing.js';
import { getTenantResolver } from '../adapters/registry.js';

export async function routeMessage(
  content: string,
  channelId: string,
  userName: string,
  orgId: string,
): Promise<RouteResult[]> {
  logger.info({ messageLength: content.length, orgId }, 'Routing incoming message');

  try {
    const orgName = await getTenantResolver().getOrgName(orgId);

    // Fetch relevant context from knowledge base
    const knowledge = await queryKnowledge(orgId, content, undefined, 5);
    const knowledgeText = knowledge.length > 0
      ? `RELEVANT KNOWLEDGE:\n${knowledge.map(k => `- ${k.topic}: ${k.content}`).join('\n')}`
      : 'No specific relevant knowledge found.';

    const prompt = `
You are the ${orgName} Team Router. Your job is to analyze incoming messages and route them to the most appropriate AI specialist agent(s).

${knowledgeText}

TEAM MEMBERS:
- agentops: Agent operations and platform internal health
- ciso: Security, auth, secrets, data isolation
- finops: Billing, stripe, compute usage, cost optimization
- product-manager: Feature design, business logic, PRD refinement
- qa-manager: Testing, playwright, regressions, quality gates
- release-engineering: Pipelines, deployments, git workflows
- sre: Reliability, observability, performance, infrastructure
- ux-designer: UI/UX, user flows, accessibility, design standards
- voc: Voice of customer, support issues, user feedback patterns
- nexus: Strategy sessions, high-level portfolio review, gatekeeper
- support: Customer support requests, user account issues, access requests

INSTRUCTIONS:
1. Identify the intent and technical domain of the user's message.
2. Select 1-2 agents who are best suited to handle this.
3. If the message is a complex strategic question requiring multiple perspectives, set isStrategySession to true.
4. Respond with a JSON array of route objects.

Example: [{"agentId": "sre", "intent": "investigation", "subMessage": "Investigate the memory leak in the worker service", "confidenceScore": 0.9, "reasoning": "User reporting OOM", "extractedEntities": {}, "needsCodeAccess": true, "isStrategySession": false, "isFallback": false}]
`.trim();

    const response = await getLLMProvider().generateText({
      model: 'ROUTER',
      systemInstruction: prompt,
      contents: [{ role: 'user', parts: [{ text: `${userName}: ${content}` }] }],
    });

    try {
      const cleaned = response.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      const results = JSON.parse(cleaned) as RouteResult[];
      
      for (const res of results) {
        logRoutingDecision(res, 0);
      }
      
      return results;
    } catch (err) {
      logger.error({ err, response }, 'Failed to parse router response');
      return [{
        agentId: 'nexus',
        intent: 'fallback',
        subMessage: content,
        confidenceScore: 0.5,
        reasoning: 'failed to parse router response',
        extractedEntities: {},
        needsCodeAccess: false,
        isStrategySession: false,
        isFallback: true,
      }];
    }
  } catch (err) {
    logger.error({ err }, 'Message routing failed');
    return [{
      agentId: 'nexus',
      intent: 'fallback',
      subMessage: content,
      confidenceScore: 0.5,
      reasoning: 'router execution failed',
      extractedEntities: {},
      needsCodeAccess: false,
      isStrategySession: false,
      isFallback: true,
    }];
  }
}
