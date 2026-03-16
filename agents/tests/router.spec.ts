// Regression suite: enforces single-agent routing (anti-chatter).
// Verifies that routeMessage() never returns > 1 agent per user turn.
// Distinct from unit tests in agents/router/__tests__/.

import '../../src/tests/env.js';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RouteResult } from '../types/routing.js';
import {
  IntentResponseSchema,
  INTENT_RESPONSE_JSON_SCHEMA,
} from '../schemas/intent.js';

// These mocks must be declared before any dynamic imports.
// vi.mock() calls are hoisted to the top of the file by vitest.
vi.mock('@google/genai');
vi.mock('fs');
vi.mock('../../src/core/guardrails/prompt_injection', () => ({
  checkForInjection: vi.fn().mockReturnValue({ detected: false }),
}));
vi.mock('../telemetry/logger', () => ({
  logRoutingDecision: vi.fn(),
  logSecurityEvent: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('router regression: single-agent routing (anti-chatter)', () => {
  let routeMessage: (
    content: string,
    channelId: string,
    userName: string,
  ) => Promise<RouteResult[]>;
  let mockGenerateContent: ReturnType<typeof vi.fn>;
  let mockReadFileSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset all modules so the router re-evaluates the feature flag on each test
    vi.resetModules();

    // Set up fs mock — must be done BEFORE importing the router
    const fsModule = await import('fs');
    mockReadFileSync = vi.mocked(fsModule.readFileSync);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ ENABLE_STRUCTURED_INTENT: true }),
    );

    // Set up @google/genai mock
    const genaiModule = await import('@google/genai');
    mockGenerateContent = vi.fn();
    vi.mocked(genaiModule.GoogleGenAI).mockImplementation(
      function () {
        return {
          models: {
            generateContent: mockGenerateContent,
          },
        } as any;
      },
    );

    // Import the router AFTER mocks are in place so it picks up the mocked deps
    const router = await import('../router/index.js');
    routeMessage = router.routeMessage;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Test 1: Ambiguity — cross-domain prompt must route to exactly one agent
  // ---------------------------------------------------------------------------
  it('returns exactly one agent for a cross-domain (security + reliability) prompt', async () => {
    const geminiPayload = {
      intent: 'InvestigateBug',
      confidenceScore: 0.85,
      targetAgent: 'sre',
      extractedEntities: { component: 'login' },
      reasoning: 'Performance issue takes priority over security routing',
      needsCodeAccess: true,
      isStrategySession: false,
      requiresConfirmation: false,
    };

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(geminiPayload),
    });

    const results = await routeMessage(
      'The login endpoint is critically slow AND has a SQL injection vulnerability',
      'channel-ambiguity',
      'tester',
    );

    expect(results.length).toBe(1);
    expect(typeof results[0].agentId).toBe('string');
    expect(results[0].isFallback).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Concurrency — 5 parallel routeMessage calls each return exactly 1 agent
  // ---------------------------------------------------------------------------
  it('returns exactly one agent per call across 5 concurrent invocations', async () => {
    const geminiPayload = {
      intent: 'InvestigateBug',
      confidenceScore: 0.85,
      targetAgent: 'sre',
      extractedEntities: { component: 'login' },
      reasoning: 'Performance issue takes priority over security routing',
      needsCodeAccess: true,
      isStrategySession: false,
      requiresConfirmation: false,
    };

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(geminiPayload),
    });

    const allResults = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        routeMessage(
          'The login endpoint is critically slow AND has a SQL injection vulnerability',
          `channel-concurrent-${i}`,
          'tester',
        ),
      ),
    );

    for (const results of allResults) {
      expect(results.length).toBe(1);
      expect(typeof results[0].agentId).toBe('string');
    }

    const firstAgentId = allResults[0][0].agentId;
    expect(allResults.every((r) => r[0].agentId === firstAgentId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Schema contract — targetAgent must be a string, not an array
  // ---------------------------------------------------------------------------
  it('rejects a targetAgent array in IntentResponseSchema and JSON schema type is string', () => {
    const validPayload = {
      intent: 'InvestigateBug' as const,
      confidenceScore: 0.85,
      targetAgent: 'sre',
      extractedEntities: { component: 'login' },
      reasoning: 'Bug investigation',
      needsCodeAccess: true,
      isStrategySession: false,
      requiresConfirmation: false,
    };

    // Zod schema must reject array targetAgent
    expect(
      IntentResponseSchema.safeParse({
        ...validPayload,
        targetAgent: ['ciso', 'sre'],
      }).success,
    ).toBe(false);

    // JSON schema must specify targetAgent type as 'string'
    expect(INTENT_RESPONSE_JSON_SCHEMA.properties.targetAgent.type).toBe(
      'string',
    );
  });
});
