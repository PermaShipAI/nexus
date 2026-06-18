import { z } from 'zod';

export const IntentSchema = z.enum([
  'InvestigateBug',
  'ProposeTask',
  'QueryKnowledge',
  'SystemStatus',
  'RequestReview',
  'StrategySession',
  'GeneralInquiry',
  'AdministrativeAction',
  'DestructiveAction',
  'StrictConsultation',
]);

export type Intent = z.infer<typeof IntentSchema>;

export const IntentResponseSchema = z.object({
  intent: IntentSchema,
  confidenceScore: z.number().min(0).max(1),
  targetAgent: z.string(),
  extractedEntities: z.record(z.string(), z.unknown()),
  reasoning: z.string(),
  needsCodeAccess: z.boolean(),
  isStrategySession: z.boolean(),
  requiresConfirmation: z.boolean(),
}).strict();

export type IntentResponse = z.infer<typeof IntentResponseSchema>;

// ---------------------------------------------------------------------------
// Chat-integration intent types (used by intent router, RBAC, and channel safety)
// ---------------------------------------------------------------------------

export const IntentKindEnum = z.enum([
  'InvestigateBug',
  'ProposeTask',
  'QueryKnowledge',
  'SystemStatus',
  'ManageProject',
  'AccessSecrets',
  'DestructiveAction',
  'Unknown',
  'StrictConsultation',
]);

export type IntentKind = z.infer<typeof IntentKindEnum>;

export const ClassifiedIntentSchema = z.object({
  kind: IntentKindEnum,
  confidenceScore: z.number().min(0).max(1),
  params: z.record(z.string(), z.string().optional()).default({}),
}).strict();

export type ClassifiedIntent = z.infer<typeof ClassifiedIntentSchema>;

export const geminiResponseSchema = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: [
        'InvestigateBug',
        'ProposeTask',
        'QueryKnowledge',
        'SystemStatus',
        'ManageProject',
        'AccessSecrets',
        'DestructiveAction',
        'Unknown',
        'StrictConsultation',
      ],
    },
    confidenceScore: { type: 'number' },
    params: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['kind', 'confidenceScore', 'params'],
  additionalProperties: false,
} as const;

export const INTENT_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [
        'InvestigateBug',
        'ProposeTask',
        'QueryKnowledge',
        'SystemStatus',
        'RequestReview',
        'StrategySession',
        'GeneralInquiry',
        'AdministrativeAction',
        'DestructiveAction',
        'StrictConsultation',
      ],
    },
    confidenceScore: { type: 'number', minimum: 0, maximum: 1 },
    targetAgent: { type: 'string' },
    extractedEntities: { type: 'object', additionalProperties: true }, // intentionally open — stores arbitrary entity key/value pairs
    reasoning: { type: 'string' },
    needsCodeAccess: { type: 'boolean' },
    isStrategySession: { type: 'boolean' },
    requiresConfirmation: { type: 'boolean' },
  },
  required: [
    'intent',
    'confidenceScore',
    'targetAgent',
    'extractedEntities',
    'reasoning',
    'needsCodeAccess',
    'isStrategySession',
    'requiresConfirmation',
  ],
  additionalProperties: false,
};
