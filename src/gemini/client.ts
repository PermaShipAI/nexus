import { GoogleGenerativeAI, type Content, type FunctionDeclaration, type GenerateContentResponse } from '@google/generative-ai';
import { permashipConfig as config } from '../adapters/permaship/config.js';
import { logger } from '../logger.js';
import { MODELS, FALLBACK_MODEL, type ModelTier } from './models.js';
import { usageReporter } from '../telemetry/usage-reporter.js';
import { getModelId } from '../settings/service.js';


const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

/** Track which models are quota-exhausted and when to retry them */
const quotaExhausted = new Map<string, number>(); // modelId → resetAt (epoch ms)

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; message?: string };
  // Standard Google AI API uses 429 for quota
  return e.status === 429 || (e.message?.includes('429') ?? false) || (e.message?.includes('RESOURCE_EXHAUSTED') ?? false);
}

/** Resolve the effective model, falling back to flash if the primary model is quota-blocked */
function resolveModel(modelId: string): string {
  const blockedUntil = quotaExhausted.get(modelId);
  if (blockedUntil && Date.now() < blockedUntil) {
    logger.warn({ model: modelId, fallback: FALLBACK_MODEL }, 'Model quota exhausted, using fallback');
    return FALLBACK_MODEL;
  }
  if (blockedUntil) {
    // Quota window has passed — clear the block
    quotaExhausted.delete(modelId);
  }
  return modelId;
}

/** Mark a model as quota-exhausted, parsing the retry delay from the error if available */
function markQuotaExhausted(modelId: string, err: unknown): void {
  let retryMs = 60 * 60 * 1000; // default: 1 hour
  const msg = (err as { message?: string })?.message ?? '';
  const match = msg.match(/retry in (\d+)h(\d+)m/);
  if (match) {
    retryMs = (parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60) * 1000;
  }
  quotaExhausted.set(modelId, Date.now() + retryMs);
  logger.warn({ model: modelId, retryMs, fallback: FALLBACK_MODEL }, 'Gemini quota exhausted, falling back');
}

export interface CallGeminiOptions {
  model: ModelTier;
  systemInstruction?: string;
  contents: Content[];
  orgId?: string;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

export interface CallGeminiWithToolsOptions extends CallGeminiOptions {
  tools: FunctionDeclaration[];
}

export async function callGemini(options: CallGeminiOptions): Promise<string> {
  const defaultModelId = MODELS[options.model];
  const overrideModelId = options.orgId ? await getModelId(options.model, options.orgId) : null;
  const requestedModelId = overrideModelId || defaultModelId;

  const modelId = resolveModel(requestedModelId);
  logger.debug({ model: modelId, tier: options.model }, 'Calling Gemini');


  try {
    const model = genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: options.systemInstruction,
      generationConfig: {
        responseMimeType: options.responseMimeType,
        responseSchema: options.responseSchema as any,
      }
    });

    const result = await model.generateContent({
      contents: options.contents,
    });
    const response = await result.response;
    const text = response.text();

    logger.debug({ model: modelId, responseLength: text.length }, 'Gemini response received');
    if (options.orgId && response.usageMetadata) {
      const inputTokens = response.usageMetadata.promptTokenCount ?? 0;
      const outputTokens = response.usageMetadata.candidatesTokenCount ?? 0;
      if (inputTokens > 0 || outputTokens > 0) {
        usageReporter.record(options.orgId, { inputTokens, outputTokens });
      }
    }
    return text;
  } catch (err) {
    if (isQuotaError(err) && modelId === requestedModelId && modelId !== FALLBACK_MODEL) {
      markQuotaExhausted(modelId, err);
      // Recursively call with fallback handled by resolveModel in next turn
      return callGemini(options);
    }
    throw err;
  }
}

export async function embedText(text: string): Promise<number[] | null> {
  try {
    logger.debug({ textLength: text.length }, 'Generating embedding');
    const model = genAI.getGenerativeModel({ model: MODELS.EMBEDDING });
    const result = await model.embedContent(text);
    return result.embedding.values;
  } catch (err) {
    logger.warn({ err }, 'Failed to generate embedding, falling back to null');
    return null;
  }
}

export interface ToolCallResult {
  text: string | null;
  functionCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
  raw: GenerateContentResponse;
}

function parseToolCallResponse(response: GenerateContentResponse, orgId?: string): ToolCallResult {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const functionCalls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({
      name: p.functionCall!.name!,
      args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
    }));

  const text = parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join('');

  if (orgId && response.usageMetadata) {
    const inputTokens = response.usageMetadata.promptTokenCount ?? 0;
    const outputTokens = response.usageMetadata.candidatesTokenCount ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
      usageReporter.record(orgId, { inputTokens, outputTokens });
    }
  }

  return {
    text: text || null,
    functionCalls,
    raw: response,
  };
}

export async function callGeminiWithTools(
  options: CallGeminiWithToolsOptions,
): Promise<ToolCallResult> {
  const defaultModelId = MODELS[options.model];
  const overrideModelId = options.orgId ? await getModelId(options.model, options.orgId) : null;
  const requestedModelId = overrideModelId || defaultModelId;

  const modelId = resolveModel(requestedModelId);
  logger.debug({ model: modelId, toolCount: options.tools.length, tier: options.model }, 'Calling Gemini with tools');


  try {
    const model = genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: options.systemInstruction,
      tools: [{ functionDeclarations: options.tools }],
    });

    const result = await model.generateContent({
      contents: options.contents,
    });
    const response = await result.response;
    return parseToolCallResponse(response, options.orgId);
  } catch (err) {
    if (isQuotaError(err) && modelId === requestedModelId && modelId !== FALLBACK_MODEL) {
      markQuotaExhausted(modelId, err);
      return callGeminiWithTools(options);
    }
    throw err;
  }
}
