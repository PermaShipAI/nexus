import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mock fns are available inside vi.mock factories (which are hoisted)
const {
  mockAnthropicProvider,
  mockOpenAIProvider,
  mockOllamaProvider,
  mockDefaultLLMProvider,
  mockMultiProvider,
  mockConfig,
} = vi.hoisted(() => {
  // vi.fn() with class-like implementation so `new Provider()` works
  const makeMockClass = (type: string) =>
    vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.type = type;
    });
  return {
    mockAnthropicProvider: makeMockClass('anthropic'),
    mockOpenAIProvider: makeMockClass('openai'),
    mockOllamaProvider: makeMockClass('ollama'),
    mockDefaultLLMProvider: makeMockClass('gemini'),
    mockMultiProvider: makeMockClass('multi'),
    mockConfig: {
      LLM_PROVIDER: 'gemini',
      LLM_API_KEY: 'test-api-key',
      GEMINI_API_KEY: 'test-gemini-key',
      OLLAMA_BASE_URL: 'http://localhost:11434',
    } as Record<string, string>,
  };
});

vi.mock('./anthropic.js', () => ({ AnthropicProvider: mockAnthropicProvider }));
vi.mock('./openai.js', () => ({ OpenAIProvider: mockOpenAIProvider }));
vi.mock('./ollama.js', () => ({ OllamaProvider: mockOllamaProvider }));
vi.mock('../../adapters/default/llm-provider.js', () => ({ DefaultLLMProvider: mockDefaultLLMProvider }));
vi.mock('./multi.js', () => ({ MultiProvider: mockMultiProvider }));

vi.mock('../../config.js', () => ({
  config: new Proxy({} as Record<string, string>, {
    get: (_target, prop: string) => mockConfig[prop] ?? '',
  }),
}));

import { createLLMProvider } from './factory.js';

describe('createLLMProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.LLM_PROVIDER = 'gemini';
    mockConfig.LLM_API_KEY = 'test-api-key';
    mockConfig.GEMINI_API_KEY = 'test-gemini-key';
  });

  it('creates Gemini provider by default', () => {
    createLLMProvider();
    expect(mockDefaultLLMProvider).toHaveBeenCalledOnce();
  });

  it('creates Anthropic provider when configured', () => {
    mockConfig.LLM_PROVIDER = 'anthropic';
    createLLMProvider();
    expect(mockAnthropicProvider).toHaveBeenCalledWith('test-api-key');
  });

  it('creates OpenAI provider when configured', () => {
    mockConfig.LLM_PROVIDER = 'openai';
    createLLMProvider();
    expect(mockOpenAIProvider).toHaveBeenCalledWith('test-api-key');
  });

  it('creates OpenRouter with correct base URL', () => {
    mockConfig.LLM_PROVIDER = 'openrouter';
    createLLMProvider();
    expect(mockOpenAIProvider).toHaveBeenCalledWith(
      'test-api-key',
      {},
      'https://openrouter.ai/api/v1',
    );
  });

  it('creates Ollama provider without requiring API key', () => {
    mockConfig.LLM_PROVIDER = 'ollama';
    mockConfig.LLM_API_KEY = '';
    createLLMProvider();
    expect(mockOllamaProvider).toHaveBeenCalledWith('http://localhost:11434');
  });

  it('throws for unknown provider', () => {
    mockConfig.LLM_PROVIDER = 'nonexistent';
    expect(() => createLLMProvider()).toThrow('Unknown LLM provider: nonexistent');
  });

  it('throws when Anthropic is selected without API key', () => {
    mockConfig.LLM_PROVIDER = 'anthropic';
    mockConfig.LLM_API_KEY = '';
    mockConfig.GEMINI_API_KEY = '';
    expect(() => createLLMProvider()).toThrow('LLM_API_KEY is required for Anthropic provider');
  });

  it('throws when OpenAI is selected without API key', () => {
    mockConfig.LLM_PROVIDER = 'openai';
    mockConfig.LLM_API_KEY = '';
    mockConfig.GEMINI_API_KEY = '';
    expect(() => createLLMProvider()).toThrow('LLM_API_KEY is required for OpenAI provider');
  });

  it('creates MultiProvider when provider is "multi"', () => {
    mockConfig.LLM_PROVIDER = 'multi';
    createLLMProvider();
    expect(mockMultiProvider).toHaveBeenCalledOnce();
  });
});
