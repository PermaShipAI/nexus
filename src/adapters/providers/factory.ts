import { config } from '../../config.js';
import type { LLMProvider, ModelTier } from '../interfaces/llm-provider.js';
import { DefaultLLMProvider } from '../default/llm-provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import { MultiProvider } from './multi.js';
import { SecretRedactionProvider } from './secret-redaction.js';

function buildSingleProvider(name: string, apiKey: string): LLMProvider {
  switch (name) {
    case 'gemini':
      return new DefaultLLMProvider(apiKey || config.GEMINI_API_KEY || '');
    case 'anthropic':
      if (!apiKey) throw new Error('LLM_API_KEY is required for Anthropic provider');
      return new AnthropicProvider(apiKey);
    case 'openai':
      if (!apiKey) throw new Error('LLM_API_KEY is required for OpenAI provider');
      return new OpenAIProvider(apiKey);
    case 'openrouter':
      if (!apiKey) throw new Error('LLM_API_KEY is required for OpenRouter provider');
      return new OpenAIProvider(apiKey, {}, 'https://openrouter.ai/api/v1');
    case 'ollama':
      return new OllamaProvider(config.OLLAMA_BASE_URL);
    default:
      throw new Error(`Unknown LLM provider: ${name}`);
  }
}

const TIERS: ModelTier[] = ['ROUTER', 'AGENT', 'WORK', 'EMBEDDING'];

function buildMultiProvider(): LLMProvider {
  const apiKey = config.LLM_API_KEY;
  const tierProviders: Partial<Record<ModelTier, LLMProvider>> = {};

  for (const tier of TIERS) {
    const envKey = `LLM_${tier}_PROVIDER` as keyof typeof process.env;
    const providerName = process.env[envKey];
    if (providerName) {
      const tierKeyEnv = `LLM_${tier}_API_KEY` as keyof typeof process.env;
      const tierKey = process.env[tierKeyEnv] || apiKey;
      tierProviders[tier] = buildSingleProvider(providerName, tierKey ?? '');
    }
  }

  // Fallback provider — use LLM_PROVIDER or gemini
  const fallbackName = config.LLM_PROVIDER === 'multi' ? 'gemini' : config.LLM_PROVIDER;
  const fallback = buildSingleProvider(fallbackName, apiKey ?? '');

  // Embedding provider — use EMBEDDING tier if configured, else fallback
  const embeddingProvider = tierProviders.EMBEDDING;

  return new MultiProvider(tierProviders, fallback, embeddingProvider);
}

/**
 * Create an LLM provider based on environment configuration.
 *
 * Simple mode:   LLM_PROVIDER=anthropic + LLM_API_KEY=sk-...
 * Advanced mode:  LLM_PROVIDER=multi + LLM_ROUTER_PROVIDER=gemini + LLM_AGENT_PROVIDER=anthropic + ...
 */
export function createLLMProvider(): LLMProvider {
  const provider = config.LLM_PROVIDER;

  let inner: LLMProvider;
  if (provider === 'multi') {
    inner = buildMultiProvider();
  } else {
    const apiKey = config.LLM_API_KEY || config.GEMINI_API_KEY || '';
    inner = buildSingleProvider(provider, apiKey);
  }

  return new SecretRedactionProvider(inner);
}
