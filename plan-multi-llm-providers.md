# Plan: Multi-LLM Provider Support

## Goal

Replace the Gemini-only LLM backend with a provider-agnostic system. Users can choose Anthropic Claude, OpenAI, Google Gemini, Ollama (local), or other providers to power the agent logic engine.

## Current State

The adapter interface is already in place:

```typescript
interface LLMProvider {
  generateText(options: GenerateTextOptions): Promise<string>;
  generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult>;
  embedText(text: string): Promise<number[] | null>;
}
```

Currently only `GeminiLLMProvider` exists. All 8 call sites go through `getLLMProvider()`.

### Call Sites by Model Tier

| Tier | Purpose | Call Sites |
|------|---------|------------|
| `ROUTER` | Fast classification/routing | router, sanitizer (x2), proposal-service, strategy |
| `AGENT` | Conversational agent responses | executor |
| `WORK` | Deep analysis/reflection | reflection |
| `EMBEDDING` | Vector generation for RAG | knowledge/service (x3), knowledge/sync (x2) |

### What Each Tier Actually Needs

- **ROUTER**: Fast text-in → text-out. No tool calling. Structured JSON output preferred.
- **AGENT**: Text-in → text-out. No tool calling (structured XML blocks parsed post-hoc). Needs long context.
- **WORK**: Text-in → text-out. Same as AGENT but can be slower/smarter.
- **EMBEDDING**: Text → float vector. Separate capability — some providers don't offer this.

`generateWithTools()` is defined but **never called** in the current codebase. All "tool use" is done via XML blocks in the agent's text output, parsed in `executor.ts`. So tool calling support is nice-to-have, not blocking.

---

## New Files

```
src/adapters/providers/
  anthropic.ts           # Claude via Anthropic API
  openai.ts              # GPT-4 / o3 via OpenAI API
  ollama.ts              # Local models via Ollama
  openrouter.ts          # Any model via OpenRouter API
  multi.ts               # Composite: route different tiers to different providers
```

## Provider Implementations

### Anthropic Claude

```typescript
// src/adapters/providers/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, GenerateTextOptions, ... } from '../interfaces/llm-provider.js';

const MODEL_MAP: Record<ModelTier, string> = {
  ROUTER: 'claude-haiku-4-5-20251001',
  AGENT:  'claude-sonnet-4-6-20250116',
  WORK:   'claude-sonnet-4-6-20250116',
  EMBEDDING: '',  // Anthropic has no embedding API — fall back
};

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const response = await this.client.messages.create({
      model: MODEL_MAP[options.model],
      max_tokens: 8192,
      system: options.systemInstruction,
      messages: options.contents.map(c => ({
        role: c.role === 'model' ? 'assistant' : c.role,
        content: c.parts.map(p => p.text ?? '').join(''),
      })),
    });
    this.trackUsage(options.orgId, response.usage);
    return response.content[0].type === 'text' ? response.content[0].text : '';
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    const response = await this.client.messages.create({
      model: MODEL_MAP[options.model],
      max_tokens: 8192,
      system: options.systemInstruction,
      messages: /* ... */,
      tools: options.tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.parameters ?? { type: 'object', properties: {} },
      })),
    });
    // Extract text blocks and tool_use blocks from response.content
    // Map to LLMToolCallResult format
  }

  async embedText(text: string): Promise<number[] | null> {
    // Anthropic has no embedding API.
    // Options: (a) return null, (b) delegate to a separate embedding provider
    return null;
  }
}
```

### OpenAI

```typescript
// src/adapters/providers/openai.ts
import OpenAI from 'openai';

const MODEL_MAP: Record<ModelTier, string> = {
  ROUTER: 'gpt-4.1-mini',
  AGENT:  'gpt-4.1',
  WORK:   'o3',
  EMBEDDING: 'text-embedding-3-small',
};

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const messages = [];
    if (options.systemInstruction) {
      messages.push({ role: 'system', content: options.systemInstruction });
    }
    for (const c of options.contents) {
      messages.push({
        role: c.role === 'model' ? 'assistant' : c.role,
        content: c.parts.map(p => p.text ?? '').join(''),
      });
    }
    const response = await this.client.chat.completions.create({
      model: MODEL_MAP[options.model],
      messages,
    });
    this.trackUsage(options.orgId, response.usage);
    return response.choices[0]?.message?.content ?? '';
  }

  async embedText(text: string): Promise<number[] | null> {
    const response = await this.client.embeddings.create({
      model: MODEL_MAP.EMBEDDING,
      input: text,
    });
    return response.data[0]?.embedding ?? null;
  }
}
```

### Ollama (Local)

```typescript
// src/adapters/providers/ollama.ts

const MODEL_MAP: Record<ModelTier, string> = {
  ROUTER: 'llama3.3',
  AGENT:  'qwen3:32b',
  WORK:   'qwen3:32b',
  EMBEDDING: 'nomic-embed-text',
};

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;

  constructor(baseUrl = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_MAP[options.model],
        messages: [
          ...(options.systemInstruction ? [{ role: 'system', content: options.systemInstruction }] : []),
          ...options.contents.map(c => ({
            role: c.role === 'model' ? 'assistant' : c.role,
            content: c.parts.map(p => p.text ?? '').join(''),
          })),
        ],
        stream: false,
      }),
    });
    const data = await response.json();
    return data.message?.content ?? '';
  }

  async embedText(text: string): Promise<number[] | null> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_MAP.EMBEDDING, input: text }),
    });
    const data = await response.json();
    return data.embeddings?.[0] ?? null;
  }
}
```

### OpenRouter (Any Model)

```typescript
// src/adapters/providers/openrouter.ts
// Uses OpenAI-compatible API with model routing

export class OpenRouterProvider implements LLMProvider {
  // Same as OpenAI but with:
  // - baseURL: 'https://openrouter.ai/api/v1'
  // - Model IDs like 'anthropic/claude-sonnet-4-6', 'google/gemini-2.5-flash', etc.
  // - Configurable model map via env vars
}
```

### Composite Provider (Mix-and-Match)

Route different tiers to different providers:

```typescript
// src/adapters/providers/multi.ts

export class MultiProvider implements LLMProvider {
  constructor(
    private providers: Partial<Record<ModelTier, LLMProvider>>,
    private fallback: LLMProvider,
    private embeddingProvider?: LLMProvider,
  ) {}

  async generateText(options: GenerateTextOptions): Promise<string> {
    const provider = this.providers[options.model] ?? this.fallback;
    return provider.generateText(options);
  }

  async embedText(text: string): Promise<number[] | null> {
    const provider = this.embeddingProvider ?? this.fallback;
    return provider.embedText(text);
  }
}

// Usage: Anthropic for AGENT/WORK, Gemini for ROUTER (cheap), OpenAI for embeddings
```

---

## Configuration

```bash
# .env — simple mode (one provider for everything)
LLM_PROVIDER=anthropic              # gemini | anthropic | openai | ollama | openrouter
LLM_API_KEY=sk-ant-...

# .env — advanced mode (per-tier routing)
LLM_PROVIDER=multi
LLM_ROUTER_PROVIDER=gemini
LLM_ROUTER_API_KEY=...
LLM_ROUTER_MODEL=gemini-2.5-flash   # optional override
LLM_AGENT_PROVIDER=anthropic
LLM_AGENT_API_KEY=sk-ant-...
LLM_WORK_PROVIDER=anthropic
LLM_WORK_API_KEY=sk-ant-...
LLM_EMBEDDING_PROVIDER=openai
LLM_EMBEDDING_API_KEY=sk-...

# Ollama (no API key needed)
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
```

Provider factory:

```typescript
function createLLMProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER ?? 'gemini';

  switch (provider) {
    case 'gemini':    return new GeminiLLMProvider();
    case 'anthropic': return new AnthropicProvider(process.env.LLM_API_KEY!);
    case 'openai':    return new OpenAIProvider(process.env.LLM_API_KEY!);
    case 'ollama':    return new OllamaProvider(process.env.OLLAMA_BASE_URL);
    case 'openrouter':return new OpenRouterProvider(process.env.LLM_API_KEY!);
    case 'multi':     return buildMultiProvider(); // reads per-tier env vars
    default:          throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
  }
}
```

## Usage Tracking

Currently `usageReporter.record()` is called inside `gemini/client.ts`. For multi-provider:

- Move usage tracking into each provider implementation
- Each provider extracts tokens from its own response format:
  - Gemini: `response.usageMetadata.promptTokenCount`
  - Anthropic: `response.usage.input_tokens`
  - OpenAI: `response.usage.prompt_tokens`
  - Ollama: `response.eval_count` (approximate)
- All call `usageReporter.record(orgId, { inputTokens, outputTokens })` with the same shape

## Embedding Compatibility

Not all providers offer embeddings:

| Provider | Embedding Support |
|----------|-------------------|
| Gemini | Yes (`gemini-embedding-001`) |
| OpenAI | Yes (`text-embedding-3-small`) |
| Ollama | Yes (`nomic-embed-text`, etc.) |
| Anthropic | No |
| OpenRouter | Depends on model |

For providers without embeddings, the `MultiProvider` pattern lets you mix: e.g., Anthropic for text generation + OpenAI for embeddings. Or `embedText()` returns `null` and knowledge search falls back to ILIKE text matching (already implemented in `knowledge/service.ts`).

## Model ID Overrides

Allow users to override specific model IDs via env vars:

```bash
LLM_ROUTER_MODEL=claude-haiku-4-5-20251001    # override ROUTER tier model
LLM_AGENT_MODEL=claude-sonnet-4-6-20250116    # override AGENT tier model
LLM_EMBEDDING_MODEL=text-embedding-3-large     # override embedding model
```

Each provider reads these overrides and falls back to its hardcoded defaults.

## New Dependencies

```json
{
  "@anthropic-ai/sdk": "^0.52.0",   // only if using Anthropic
  "openai": "^5.0.0",               // only if using OpenAI/OpenRouter
}
```

These should be optional peer dependencies — only needed if the user selects that provider.

## Open Questions

- Should we support streaming for long agent responses? (currently all sync)
- Should model tier → model ID mapping be fully configurable via config file?
- Should we add a provider health check / fallback chain? (if primary fails, try secondary)
- Should the Gemini implementation stay in `src/gemini/client.ts` or move to `src/adapters/providers/gemini.ts`?

## Estimated Scope

- ~150 lines per provider (5 providers = ~750 lines)
- ~100 lines: MultiProvider composite
- ~80 lines: factory + config parsing
- ~50 lines: usage tracking per provider
- 0 changes to call sites (all go through `getLLMProvider()` already)
