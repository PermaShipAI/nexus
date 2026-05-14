import { queryKnowledge } from '../knowledge/service.js';
import { getLLMProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';
import { logRoutingDecision, logSecurityEvent } from '../../agents/telemetry/logger.js';
import type { RouteResult } from '../../agents/types/routing.js';
import { getTenantResolver } from '../adapters/registry.js';
import { getAllAgents } from '../agents/registry.js';
import { checkForInjection, sanitizeIndirectInput } from '../core/guardrails/prompt_injection.js';

const INJECTION_REFUSAL: RouteResult = {
  agentId: 'none',
  intent: 'GeneralInquiry',
  subMessage: '',
  confidenceScore: 0,
  reasoning: 'Prompt injection detected',
  extractedEntities: {},
  needsCodeAccess: false,
  isStrategySession: false,
  isFallback: true,
  fallbackMessage: "I'm unable to process that request.",
};

export async function routeMessage(
  content: string,
  channelId: string,
  userName: string,
  orgId: string,
  allowedAgentIds?: string[],
): Promise<RouteResult[]> {
  const injectionCheck = checkForInjection(content);
  if (injectionCheck.detected) {
    logSecurityEvent('prompt_injection_detected', {
      matchedPattern: injectionCheck.matchedPattern,
      channelId,
      userName,
      orgId,
    });
    return [{ ...INJECTION_REFUSAL, subMessage: content }];
  }

  logger.info({ messageLength: content.length, orgId }, 'Routing incoming message');

  try {
    const orgName = await getTenantResolver().getOrgName(orgId);

    // Fetch relevant context from knowledge base
    const knowledge = await queryKnowledge(orgId, content, undefined, 5);
    const knowledgeText = knowledge.length > 0
      ? `RELEVANT KNOWLEDGE:\n${knowledge.map(k => `- ${sanitizeIndirectInput(k.topic)}: ${sanitizeIndirectInput(k.content)}`).join('\n')}`
      : 'No specific relevant knowledge found.';

    // Build team members list — constrained to allowed agents if specified
    let agents = getAllAgents();
    if (allowedAgentIds?.length) {
      const allowed = new Set(allowedAgentIds);
      agents = agents.filter(a => allowed.has(a.id));
    }
    const knownAgentIds = new Set(agents.map(a => a.id));
    const teamList = agents.map(a => `- ${a.id}: ${a.title}`).join('\n');

    const prompt = `
You are the ${orgName} Team Router. Your job is to analyze incoming messages and route them to the most appropriate AI specialist agent(s).

${knowledgeText}

TEAM MEMBERS:
${teamList}

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

      // Pre-flight: discard routes whose agentId is not in the known registry.
      // This prevents hallucinated or injected agentIds from reaching the executor.
      const agentIdPattern = /^[a-z][a-z0-9-]*$/;
      const validResults = results.filter(r => {
        if (!r.agentId || typeof r.agentId !== 'string') return false;
        if (!agentIdPattern.test(r.agentId)) {
          logger.warn({ agentId: r.agentId }, 'Router returned agentId with invalid format, dropping route');
          return false;
        }
        if (!knownAgentIds.has(r.agentId as import('../agents/types.js').AgentId)) {
          logger.warn({ agentId: r.agentId }, 'Router returned unknown agentId, dropping route');
          return false;
        }
        return true;
      });

      // Detect deep research requests based on investigation keywords
      const deepResearchKeywords = /\b(investigate|trace through|audit thoroughly|analyze security of|deep dive|root cause analysis)\b/i;
      for (const res of validResults) {
        if (res.needsCodeAccess && deepResearchKeywords.test(content)) {
          res.needsDeepResearch = true;
        }
        logRoutingDecision(res, 0);
      }

      return validResults;
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
