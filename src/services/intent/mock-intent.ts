import { z } from "zod";

export const IntentResponseSchema = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  extractedEntities: z.record(z.unknown()).optional().default({}),
  targetAgent: z.string().optional().default(""),
});

export type IntentResponse = z.infer<typeof IntentResponseSchema>;

export function getMockIntent(): IntentResponse | null {
  if (process.env.NODE_ENV === "production") return null;
  if (process.env.MOCK_INTENT_ENABLED !== "true") return null;
  const raw = process.env.MOCK_INTENT_VALUE;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const result = IntentResponseSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
