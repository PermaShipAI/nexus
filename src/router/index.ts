import { queryKnowledge } from '../knowledge/service.js';
import { getLLMProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';
import { logRoutingDecision, logSecurityEvent, logAdministrativeIntentClarificationEvent } from '../../agents/telemetry/logger.js';
import { IntentResponseSchema, INTENT_RESPONSE_JSON_SCHEMA } from '../../agents/schemas/intent.js';
import type { RouteResult } from '../../agents/types/routing.js';
import { getTenantResolver } from '../adapters/registry.js';
import { getAllAgents } from '../agents/registry.js';
import { checkForInjection } from '../core/guardrails/prompt_injection.js';

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
      ? `RELEVANT KNOWLEDGE:\n${knowledge.map(k => `- ${k.topic}: ${k.content}`).join('\n')}`
      : 'No specific relevant knowledge found.';

    // Build team members list — constrained to allowed agents if specified
    let agents = getAllAgents();
    if (allowedAgentIds?.length) {
      const allowed = new Set(allowedAgentIds);
      agents = agents.filter(a => allowed.has(a.id));
    }
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
      responseSchema: INTENT_RESPONSE_JSON_SCHEMA,
    });

    let parsed: unknown;
    try {
      const cleaned = response.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      parsed = JSON.parse(cleaned);
    } catch (err) {
      logger.error({ err, response }, 'Failed to parse router response');
      return [{
        agentId: 'none',
        intent: 'GeneralInquiry',
        subMessage: content,
        confidenceScore: 0,
        reasoning: 'failed to parse router response',
        extractedEntities: {},
        needsCodeAccess: false,
        isStrategySession: false,
        isFallback: true,
        fallbackMessage: 'I had trouble understanding your request. Could you rephrase it?',
      }];
    }

    // If the LLM returned a single object (structured output), wrap it for validation
    const candidates = Array.isArray(parsed) ? parsed : [parsed];

    const results: RouteResult[] = [];
    for (const candidate of candidates) {
      const validation = IntentResponseSchema.safeParse(candidate);
      if (!validation.success) {
        logger.warn({ issues: validation.error.issues }, 'Router response failed Zod validation');
        results.push({
          agentId: 'none',
          intent: 'GeneralInquiry',
          subMessage: content,
          confidenceScore: 0,
          reasoning: 'router response failed schema validation',
          extractedEntities: {},
          needsCodeAccess: false,
          isStrategySession: false,
          isFallback: true,
          fallbackMessage: 'I had trouble understanding your request. Could you rephrase it?',
        });
        continue;
      }

      const intentData = validation.data;

      if (intentData.confidenceScore < 0.6) {
        const fallbackMessage = buildClarificationMessage(intentData.intent);
        if (intentData.intent === 'AdministrativeAction') {
          logAdministrativeIntentClarificationEvent({
            confidenceScore: intentData.confidenceScore,
            channelId,
            userName,
          });
        }
        const lowConfidenceResult: RouteResult = {
          agentId: 'none',
          intent: intentData.intent,
          subMessage: content,
          confidenceScore: intentData.confidenceScore,
          reasoning: intentData.reasoning,
          extractedEntities: intentData.extractedEntities ?? {},
          needsCodeAccess: false,
          isStrategySession: false,
          isFallback: true,
          fallbackMessage,
        };
        logRoutingDecision(lowConfidenceResult, 0);
        results.push(lowConfidenceResult);
        continue;
      }

      // Detect deep research requests based on investigation keywords
      const deepResearchKeywords = /\b(investigate|trace through|audit thoroughly|analyze security of|deep dive|root cause analysis)\b/i;
      const res: RouteResult = {
        agentId: intentData.targetAgent,
        intent: intentData.intent,
        subMessage: content,
        confidenceScore: intentData.confidenceScore,
        reasoning: intentData.reasoning,
        extractedEntities: intentData.extractedEntities ?? {},
        needsCodeAccess: intentData.needsCodeAccess,
        isStrategySession: intentData.isStrategySession,
        isFallback: false,
      };
      if (res.needsCodeAccess && deepResearchKeywords.test(content)) {
        res.needsDeepResearch = true;
      }
      logRoutingDecision(res, 0);
      results.push(res);
    }

    return results;
  } catch (err) {
    logger.error({ err }, 'Message routing failed');
    return [{
      agentId: 'none',
      intent: 'GeneralInquiry',
      subMessage: content,
      confidenceScore: 0,
      reasoning: 'router execution failed',
      extractedEntities: {},
      needsCodeAccess: false,
      isStrategySession: false,
      isFallback: true,
      fallbackMessage: 'I had trouble understanding your request. Could you rephrase it?',
    }];
  }
}

function buildClarificationMessage(intent: string): string {
  switch (intent) {
    case 'AdministrativeAction':
      return "I want to make sure I understand your system configuration request. Are you trying to enable/disable a feature, update a setting, or something else? For example: 'enable autonomous mode' or 'set log level to debug'.";
    case 'InvestigateBug':
      return "Could you describe the bug you'd like me to investigate? For example, 'users can't log in' or 'API returns 500 errors'.";
    case 'ProposeTask':
      return "Could you describe the task you'd like to propose? For example, 'add unit tests for the auth module'.";
    case 'DestructiveAction':
      return "Could you be more specific about what you'd like me to delete or reset? For example, 'delete the staging database' or 'reset the cache'.";
    default:
      return "Could you provide more details about what you'd like me to do?";
  }
}
