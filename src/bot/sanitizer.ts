import { getLLMProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';

const SANITIZER_SYSTEM_PROMPT = `You are a message sanitizer for a public-facing Discord channel. Rewrite the following agent message to:
1. Remove any exploit details, attack vectors, or vulnerability reproduction steps
2. Remove internal file paths, code snippets, database queries, and infrastructure details
3. Remove internal project codenames, repo keys, and API endpoint paths
4. Keep the overall meaning and any actionable information for end users
5. Use plain, non-technical language accessible to average users
6. If the entire message is purely internal/technical with no public value, return "[internal update]"

Return ONLY the rewritten message, nothing else.`;

export async function sanitizeForPublic(content: string): Promise<string> {
  try {
    const sanitized = await getLLMProvider().generateText({
      model: 'ROUTER',
      systemInstruction: SANITIZER_SYSTEM_PROMPT,
      contents: [{ role: 'user', parts: [{ text: content }] }],
    });

    return sanitized.trim() || '[internal update]';
  } catch (err) {
    logger.error({ err }, 'Failed to sanitize message for public channel');
    return '[internal update]';
  }
}

export interface AgentResponse {
  agentTitle: string;
  agentId: string;
  content: string;
}

const SYNTHESIZER_SYSTEM_PROMPT = `You are writing a single, brief Discord reply on behalf of a support team. Multiple internal specialists have analyzed the user's message. Your job is to combine their findings into ONE concise, friendly response.

Rules:
- Write 1-3 sentences maximum. Be warm but brief.
- If a ticket/proposal was submitted, say something like "We've noted this and our team will look into it" — do NOT mention ticket IDs, proposal systems, or internal processes.
- Do NOT mention individual agent names, roles, or that multiple specialists reviewed it.
- Do NOT include internal file paths, code snippets, technical jargon, or infrastructure details.
- Do NOT repeat the user's message back to them.
- If the agents answered a question, give the answer directly.
- If the agents identified a bug/issue, acknowledge it and reassure the user.
- If no agent had anything useful to say, respond with a brief acknowledgment.
- Use plain language accessible to any user.

Return ONLY the final message, nothing else.`;

/**
 * Synthesize multiple agent responses into a single user-facing reply for public channels.
 * Replaces posting each agent's response individually.
 */
export async function synthesizePublicReply(
  userMessage: string,
  responses: AgentResponse[],
): Promise<string> {
  if (responses.length === 0) return '';

  // Single response: just sanitize it directly (no need for synthesis overhead)
  if (responses.length === 1) {
    return sanitizeForPublic(responses[0].content);
  }

  const agentInputs = responses
    .map((r) => `[${r.agentTitle}]:\n${r.content}`)
    .join('\n\n---\n\n');

  const prompt = `USER MESSAGE:\n"${userMessage}"\n\nAGENT RESPONSES:\n${agentInputs}`;

  try {
    const synthesized = await getLLMProvider().generateText({
      model: 'ROUTER',
      systemInstruction: SYNTHESIZER_SYSTEM_PROMPT,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const result = synthesized.trim();
    if (!result) return '[internal update]';

    logger.info({ agentCount: responses.length, outputLength: result.length }, 'Synthesized public reply');
    return result;
  } catch (err) {
    logger.error({ err }, 'Failed to synthesize public reply, falling back to first response');
    return sanitizeForPublic(responses[0].content);
  }
}
