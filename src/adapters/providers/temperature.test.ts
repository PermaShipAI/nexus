import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be created before any import that resolves these paths
// ---------------------------------------------------------------------------
const { mockAnthropicCreate, mockOpenAICreate, mockUsageReporter } = vi.hoisted(() => {
  const mockAnthropicCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  const mockOpenAICreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'ok', tool_calls: [] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const mockUsageReporter = { record: vi.fn() };
  return { mockAnthropicCreate, mockOpenAICreate, mockUsageReporter };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.messages = { create: mockAnthropicCreate };
  }),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.chat = { completions: { create: mockOpenAICreate } };
    this.embeddings = { create: vi.fn() };
  }),
}));

vi.mock('../../telemetry/usage-reporter.js', () => ({
  usageReporter: mockUsageReporter,
}));

vi.mock('./retry.js', () => ({
  withRetry: vi.fn().mockImplementation((fn: () => unknown) => fn()),
}));

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

const CONTENTS = [{ role: 'user', parts: [{ text: 'route this' }] }];

// ---------------------------------------------------------------------------
// AnthropicProvider — temperature enforcement
// ---------------------------------------------------------------------------
describe('AnthropicProvider temperature enforcement', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider('test-key');
    // Restore default mock value after clearAllMocks
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    });
  });

  it('sets temperature=0 for ROUTER tier in generateText', async () => {
    await provider.generateText({ model: 'ROUTER', contents: CONTENTS });
    expect(mockAnthropicCreate).toHaveBeenCalledOnce();
    const call = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBe(0);
  });

  it('sets temperature=0 for ROUTER tier in generateWithTools', async () => {
    await provider.generateWithTools({ model: 'ROUTER', contents: CONTENTS, tools: [] });
    expect(mockAnthropicCreate).toHaveBeenCalledOnce();
    const call = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBe(0);
  });

  it('does not set temperature for AGENT tier in generateText', async () => {
    await provider.generateText({ model: 'AGENT', contents: CONTENTS });
    const call = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBeUndefined();
  });

  it('does not set temperature for WORK tier in generateText', async () => {
    await provider.generateText({ model: 'WORK', contents: CONTENTS });
    const call = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBeUndefined();
  });

  it('respects explicit temperature override even for ROUTER tier', async () => {
    await provider.generateText({ model: 'ROUTER', contents: CONTENTS, temperature: 0.7 });
    const call = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBe(0.7);
  });

  it('respects explicit temperature=0 override for non-ROUTER tier', async () => {
    await provider.generateText({ model: 'AGENT', contents: CONTENTS, temperature: 0 });
    const call = mockAnthropicCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider — temperature enforcement
// ---------------------------------------------------------------------------
describe('OpenAIProvider temperature enforcement', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider('test-key');
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });

  it('sets temperature=0 for ROUTER tier in generateText', async () => {
    await provider.generateText({ model: 'ROUTER', contents: CONTENTS });
    expect(mockOpenAICreate).toHaveBeenCalledOnce();
    const call = mockOpenAICreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBe(0);
  });

  it('sets temperature=0 for ROUTER tier in generateWithTools', async () => {
    await provider.generateWithTools({ model: 'ROUTER', contents: CONTENTS, tools: [] });
    expect(mockOpenAICreate).toHaveBeenCalledOnce();
    const call = mockOpenAICreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBe(0);
  });

  it('does not set temperature for AGENT tier', async () => {
    await provider.generateText({ model: 'AGENT', contents: CONTENTS });
    const call = mockOpenAICreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBeUndefined();
  });

  it('respects explicit temperature override for ROUTER tier', async () => {
    await provider.generateText({ model: 'ROUTER', contents: CONTENTS, temperature: 1.0 });
    const call = mockOpenAICreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.temperature).toBe(1.0);
  });
});
