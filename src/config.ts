import 'dotenv/config';
import { z } from 'zod';

/**
 * Core configuration required by all adapter profiles.
 * PermaShip-specific vars (PERMASHIP_*, COMMS_*, GEMINI_*) are loaded
 * by the PermaShip adapters themselves, not here.
 */
const envSchema = z.object({
  // Adapter profile selection
  ADAPTER_PROFILE: z.string().default('default'),

  // LLM (generic — any Gemini-compatible API key)
  LLM_API_KEY: z.preprocess(
    (v: unknown) => v || process.env.GEMINI_API_KEY,
    z.string().min(1).optional(),
  ),

  // Standalone / single-tenant defaults
  DEFAULT_ORG_ID: z.string().uuid().optional(),
  DEFAULT_ORG_NAME: z.string().optional(),

  // Discord specific (Fallback for unified IDs if platform is missing)
  DISCORD_CHANNEL_ID: z.string().optional(),

  // Database (optional — uses embedded PGlite if not set)
  DATABASE_URL: z.string().optional(),

  // Idle timer
  IDLE_TIMEOUT_MS: z.coerce.number().default(1_200_000),

  // CTO scheduler
  CTO_REVIEW_INTERVAL_MS: z.coerce.number().default(4 * 60 * 60 * 1000), // 4 hours
  CTO_DEBOUNCE_MS: z.coerce.number().default(2 * 60 * 1000), // 2 minutes

  // Staleness checker
  STALENESS_CHECK_INTERVAL_MS: z.coerce.number().default(7_200_000), // 2 hours
  STALENESS_DEFAULT_TTL_DAYS: z.coerce.number().default(7),
  STALENESS_MAX_REVALIDATIONS: z.coerce.number().default(3),
  SECURITY_DIGEST_INTERVAL_MS: z.coerce.number().default(7 * 24 * 60 * 60 * 1000),
  SECURITY_DIGEST_CHECK_INTERVAL_MS: z.coerce.number().default(3_600_000),

  // AgentOps evaluation scheduler
  AGENTOPS_EVAL_INTERVAL_MS: z.coerce.number().default(7 * 24 * 60 * 60 * 1000), // 7 days
  AGENTOPS_EVAL_CHECK_INTERVAL_MS: z.coerce.number().default(3_600_000), // 1 hour
  AGENTOPS_EVAL_WINDOW_DAYS: z.coerce.number().default(7), // look-back window
  AGENTOPS_ADR_REJECTION_THRESHOLD: z.coerce.number().default(3), // trigger ADR draft after N rejections

  // Usage metering
  USAGE_FLUSH_INTERVAL_MS: z.coerce.number().default(60_000),
  USAGE_FLUSH_TURN_THRESHOLD: z.coerce.number().default(100),

  // Webhook verification (generic — used by any comms integration)
  WEBHOOK_SIGNING_SECRET: z.preprocess(
    (v: unknown) => v || process.env.COMMS_SIGNING_SECRET || process.env.CONDUCTOR_BOT_SECRET,
    z.string().optional(),
  ),

  // Internal API secret (for /api/internal/* routes)
  INTERNAL_SECRET: z.preprocess(
    (v: unknown) => v || process.env.PERMASHIP_INTERNAL_SECRET,
    z.string().optional(),
  ),

  // Activation / connect URL base (for workspace linking flow)
  ACTIVATION_URL: z.preprocess(
    (v: unknown) => v || process.env.PERMASHIP_API_URL,
    z.string().optional(),
  ),

  // LLM provider selection (local / multi-provider mode)
  LLM_PROVIDER: z.string().default('gemini'),
  GEMINI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),

  // Local execution backends
  EXECUTION_BACKEND: z.string().default('noop'),
  EXECUTION_TIMEOUT_MS: z.coerce.number().default(3_600_000),
  REPO_ROOT: z.string().optional(),
  LOCAL_REPOS_DIR: z.string().optional(),

  // Logging
  LOG_LEVEL: z
    .string()
    .default('info')
    .transform((v: string) => v.toLowerCase())
    .pipe(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
export const getConfig = () => config;
export type Config = z.infer<typeof envSchema>;
