import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenerateTextOptions } from '../interfaces/llm-provider.js';

// ---------------------------------------------------------------------------
// Temperature enforcement: ROUTER tier must always use temperature=0
// to ensure deterministic classification and routing results.
// ---------------------------------------------------------------------------

const { mockAnthropicCreate, mockOpenAICreate } = vi.hoisted(() => {
  const mockAnthropicCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const mockOpenAICreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'ok', tool_calls: [] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  return { mockAnthropicCreate, mockOpenAICreate };
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

vi.mock('./retry.js', () => ({
  withRetry: vi.fn().mockImplementation((fn: () => unknown) => fn()),
}));

vi.mock('../../telemetry/usage-reporter.js', () => ({
  usageReporter: { record: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

describe('ROUTER tier deterministic temperature enforcement', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockClear();
    mockOpenAICreate.mockClear();
  });

  describe('AnthropicProvider', () => {
    it('passes temperature=0 for ROUTER tier', async () => {
      const provider = new AnthropicProvider('test-key');
      const options: GenerateTextOptions = {
        model: 'ROUTER',
        contents: [{ role: 'user', parts: [{ text: 'classify this' }] }],
      };
      await provider.generateText(options);
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0 }),
      );
    });

    it('does not set temperature for AGENT tier', async () => {
      const provider = new AnthropicProvider('test-key');
      const options: GenerateTextOptions = {
        model: 'AGENT',
        contents: [{ role: 'user', parts: [{ text: 'help me' }] }],
      };
      await provider.generateText(options);
      const call = mockAnthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call).not.toHaveProperty('temperature');
    });

    it('respects an explicit temperature override on ROUTER tier', async () => {
      const provider = new AnthropicProvider('test-key');
      const options: GenerateTextOptions = {
        model: 'ROUTER',
        contents: [{ role: 'user', parts: [{ text: 'classify this' }] }],
        temperature: 0.5,
      };
      await provider.generateText(options);
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.5 }),
      );
    });
  });

  describe('OpenAIProvider', () => {
    it('passes temperature=0 for ROUTER tier', async () => {
      const provider = new OpenAIProvider('test-key');
      const options: GenerateTextOptions = {
        model: 'ROUTER',
        contents: [{ role: 'user', parts: [{ text: 'classify this' }] }],
      };
      await provider.generateText(options);
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0 }),
      );
    });

    it('does not set temperature for WORK tier', async () => {
      const provider = new OpenAIProvider('test-key');
      const options: GenerateTextOptions = {
        model: 'WORK',
        contents: [{ role: 'user', parts: [{ text: 'do the work' }] }],
      };
      await provider.generateText(options);
      const call = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call).not.toHaveProperty('temperature');
    });

    it('respects an explicit temperature override on ROUTER tier', async () => {
      const provider = new OpenAIProvider('test-key');
      const options: GenerateTextOptions = {
        model: 'ROUTER',
        contents: [{ role: 'user', parts: [{ text: 'classify this' }] }],
        temperature: 1.0,
      };
      await provider.generateText(options);
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 1.0 }),
      );
    });
  });
});
