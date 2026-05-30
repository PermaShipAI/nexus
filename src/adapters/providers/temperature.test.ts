/**
 * Tests that ROUTER-tier LLM calls enforce temperature=0 for determinism,
 * that explicit overrides are respected, and that non-ROUTER tiers omit temperature.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenerateTextOptions, GenerateWithToolsOptions } from '../interfaces/llm-provider.js';

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------
const {
  mockAnthropicCreate,
  mockAnthropicClass,
  mockChatCreate,
  mockOpenAIClass,
  mockFetch,
} = vi.hoisted(() => {
  const mockAnthropicCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  const mockAnthropicClass = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
  ) {
    this.messages = { create: mockAnthropicCreate };
  });

  const mockChatCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'ok', tool_calls: [] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });

  const mockOpenAIClass = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
  ) {
    this.chat = { completions: { create: mockChatCreate } };
    this.embeddings = { create: vi.fn() };
  });

  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ message: { content: 'ok' } }),
    text: () => Promise.resolve('ok'),
  });

  return { mockAnthropicCreate, mockAnthropicClass, mockChatCreate, mockOpenAIClass, mockFetch };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: mockAnthropicClass }));
vi.mock('openai', () => ({ default: mockOpenAIClass }));
vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../telemetry/usage-reporter.js', () => ({ usageReporter: { record: vi.fn() } }));
vi.mock('./retry.js', () => ({ withRetry: (fn: () => unknown) => fn() }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function routerText(overrides?: Partial<GenerateTextOptions>): GenerateTextOptions {
  return { model: 'ROUTER', contents: [{ role: 'user', parts: [{ text: 'ping' }] }], ...overrides };
}

function agentText(): GenerateTextOptions {
  return { model: 'AGENT', contents: [{ role: 'user', parts: [{ text: 'ping' }] }] };
}

function routerTools(overrides?: Partial<GenerateWithToolsOptions>): GenerateWithToolsOptions {
  return {
    model: 'ROUTER',
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    tools: [{ name: 'noop', description: 'no-op' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------
describe('AnthropicProvider temperature', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes temperature: 0 for ROUTER generateText by default', async () => {
    const { AnthropicProvider } = await import('./anthropic.js');
    await new AnthropicProvider('sk-test').generateText(routerText());
    expect(mockAnthropicCreate).toHaveBeenCalledOnce();
    expect(mockAnthropicCreate.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  });

  it('respects explicit temperature override on ROUTER generateText', async () => {
    const { AnthropicProvider } = await import('./anthropic.js');
    await new AnthropicProvider('sk-test').generateText(routerText({ temperature: 0.5 }));
    expect(mockAnthropicCreate.mock.calls[0][0]).toMatchObject({ temperature: 0.5 });
  });

  it('omits temperature for non-ROUTER tiers by default', async () => {
    const { AnthropicProvider } = await import('./anthropic.js');
    await new AnthropicProvider('sk-test').generateText(agentText());
    expect(mockAnthropicCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('passes temperature: 0 for ROUTER generateWithTools by default', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { AnthropicProvider } = await import('./anthropic.js');
    await new AnthropicProvider('sk-test').generateWithTools(routerTools());
    expect(mockAnthropicCreate.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  });

  it('respects explicit temperature override on ROUTER generateWithTools', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { AnthropicProvider } = await import('./anthropic.js');
    await new AnthropicProvider('sk-test').generateWithTools(routerTools({ temperature: 0.2 }));
    expect(mockAnthropicCreate.mock.calls[0][0]).toMatchObject({ temperature: 0.2 });
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider
// ---------------------------------------------------------------------------
describe('OpenAIProvider temperature', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes temperature: 0 for ROUTER generateText by default', async () => {
    const { OpenAIProvider } = await import('./openai.js');
    await new OpenAIProvider('sk-test').generateText(routerText());
    expect(mockChatCreate).toHaveBeenCalledOnce();
    expect(mockChatCreate.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  });

  it('respects explicit temperature override on ROUTER generateText', async () => {
    const { OpenAIProvider } = await import('./openai.js');
    await new OpenAIProvider('sk-test').generateText(routerText({ temperature: 0.7 }));
    expect(mockChatCreate.mock.calls[0][0]).toMatchObject({ temperature: 0.7 });
  });

  it('omits temperature for non-ROUTER tiers by default', async () => {
    const { OpenAIProvider } = await import('./openai.js');
    await new OpenAIProvider('sk-test').generateText(agentText());
    expect(mockChatCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('passes temperature: 0 for ROUTER generateWithTools by default', async () => {
    const { OpenAIProvider } = await import('./openai.js');
    await new OpenAIProvider('sk-test').generateWithTools(routerTools());
    expect(mockChatCreate.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider
// ---------------------------------------------------------------------------
describe('OllamaProvider temperature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('passes options.temperature: 0 for ROUTER generateText by default', async () => {
    const { OllamaProvider } = await import('./ollama.js');
    await new OllamaProvider().generateText(routerText());
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.options).toMatchObject({ temperature: 0 });
  });

  it('respects explicit temperature override on ROUTER generateText', async () => {
    const { OllamaProvider } = await import('./ollama.js');
    await new OllamaProvider().generateText(routerText({ temperature: 0.3 }));
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.options).toMatchObject({ temperature: 0.3 });
  });

  it('omits options for non-ROUTER tiers by default', async () => {
    const { OllamaProvider } = await import('./ollama.js');
    await new OllamaProvider().generateText(agentText());
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.options).toBeUndefined();
  });

  it('passes options.temperature: 0 for ROUTER generateWithTools by default', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: { content: '', tool_calls: [] } }),
      text: () => Promise.resolve(''),
    });
    const { OllamaProvider } = await import('./ollama.js');
    await new OllamaProvider().generateWithTools(routerTools());
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.options).toMatchObject({ temperature: 0 });
  });
});
