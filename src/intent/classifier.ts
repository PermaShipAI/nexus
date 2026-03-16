import { ClassifiedIntent, ClassifiedIntentSchema, geminiResponseSchema } from '../../agents/schemas/intent.js';
import { getMockIntent } from './mock_intents.js';
import { callGemini } from '../gemini/client.js';
import featureFlags from '../../config/feature_flags.json' with { type: 'json' };

const CLASSIFICATION_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `You are an intent classifier for the agent system.
Classify the user's message into one of these intents:
- InvestigateBug: User wants to investigate, debug, or analyze a bug or error
- ProposeTask: User wants to create, propose, or add a new task or ticket
- QueryKnowledge: User wants to know something about the project, codebase, or team
- SystemStatus: User wants to know the status of systems, deployments, or CI/CD
- ManageProject: User wants to create, update, delete, or configure a project
- AccessSecrets: User wants to retrieve, rotate, or manage secrets/credentials
- Unknown: The intent is unclear or doesn't match any category

Always return a confidenceScore between 0 and 1 reflecting how confident you are.
Extract relevant params from the message (e.g., subject, target, secretName, deleteTarget).`;

export async function classifyIntent(message: string): Promise<ClassifiedIntent> {
  // Mock mode for CI/CD — bypasses feature flag and makes no live Gemini calls
  if (process.env.INTENT_MOCK_MODE === 'true') {
    const mockResult = getMockIntent(message);
    if (mockResult) {
      return mockResult;
    }
    return { kind: 'Unknown', confidenceScore: 0.1, params: {} };
  }

  // Feature flag check — return Unknown immediately if disabled
  if (!featureFlags.ENABLE_STRUCTURED_INTENT) {
    return { kind: 'Unknown', confidenceScore: 0, params: {} };
  }

  const classifyWithTimeout = async (): Promise<ClassifiedIntent> => {
    const text = await callGemini({
      model: 'ROUTER',
      systemInstruction: SYSTEM_PROMPT,
      contents: [{ role: 'user', parts: [{ text: message }] }],
      responseMimeType: 'application/json',
      responseSchema: geminiResponseSchema as Record<string, unknown>,
    });

    const parsed = JSON.parse(text);
    return ClassifiedIntentSchema.parse(parsed);
  };

  // Race against timeout
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('TIMEOUT')), CLASSIFICATION_TIMEOUT_MS),
  );

  return Promise.race([classifyWithTimeout(), timeoutPromise]);
}
