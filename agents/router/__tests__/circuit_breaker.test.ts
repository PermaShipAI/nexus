import '../../../src/tests/env.js';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RouteResult } from '../../types/routing';

// These mocks must be declared before any dynamic imports.
vi.mock('@google/genai');
vi.mock('fs');
vi.mock('../../../src/core/guardrails/prompt_injection', () => ({
  checkForInjection: vi.fn().mockReturnValue({ detected: false }),
}));
vi.mock('../../telemetry/logger', () => ({
  logRoutingDecision: vi.fn(),
  logSecurityEvent: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Circuit Breaker module unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe('circuit_breaker module', () => {
  let lockIntent: (sessionId: string, intent: string, reason: import('../../router/circuit_breaker').LockReason) => void;
  let isIntentLocked: (sessionId: string, intent: string) => boolean;
  let clearSessionLocks: (sessionId: string) => void;
  let _resetLockStore: () => void;
  let CIRCUIT_BREAKER_MESSAGE: string;

  beforeEach(async () => {
    vi.resetModules();
    const cb = await import('../circuit_breaker.js');
    lockIntent = cb.lockIntent;
    isIntentLocked = cb.isIntentLocked;
    clearSessionLocks = cb.clearSessionLocks;
    _resetLockStore = cb._resetLockStore;
    CIRCUIT_BREAKER_MESSAGE = cb.CIRCUIT_BREAKER_MESSAGE;
    // Ensure clean state
    _resetLockStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('CIRCUIT_BREAKER_MESSAGE matches exact required value', () => {
    expect(CIRCUIT_BREAKER_MESSAGE).toBe(
      'Security Policy Check: Request previously denied. Interaction terminated.',
    );
  });

  it('lockIntent + isIntentLocked: basic round-trip returns true', () => {
    lockIntent('s1', 'ProposeTask', 'rbac_rejection');
    expect(isIntentLocked('s1', 'ProposeTask')).toBe(true);
  });

  it('isIntentLocked returns false for unknown session', () => {
    expect(isIntentLocked('unknown-session', 'ProposeTask')).toBe(false);
  });

  it('session isolation: locking session-1 does not affect session-2', () => {
    lockIntent('session-1', 'ProposeTask', 'rbac_rejection');
    expect(isIntentLocked('session-2', 'ProposeTask')).toBe(false);
  });

  it('intent isolation: locking ProposeTask does not affect QueryKnowledge in same session', () => {
    lockIntent('s1', 'ProposeTask', 'rbac_rejection');
    expect(isIntentLocked('s1', 'QueryKnowledge')).toBe(false);
  });

  it('clearSessionLocks removes all locks for a session, leaves others intact', () => {
    lockIntent('s1', 'ProposeTask', 'rbac_rejection');
    lockIntent('s1', 'QueryKnowledge', 'security_refusal');
    lockIntent('s2', 'ProposeTask', 'rbac_rejection');

    clearSessionLocks('s1');

    expect(isIntentLocked('s1', 'ProposeTask')).toBe(false);
    expect(isIntentLocked('s1', 'QueryKnowledge')).toBe(false);
    expect(isIntentLocked('s2', 'ProposeTask')).toBe(true);
  });

  it('_resetLockStore clears everything', () => {
    lockIntent('s1', 'ProposeTask', 'rbac_rejection');
    lockIntent('s2', 'QueryKnowledge', 'security_refusal');

    _resetLockStore();

    expect(isIntentLocked('s1', 'ProposeTask')).toBe(false);
    expect(isIntentLocked('s2', 'QueryKnowledge')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Router integration tests with circuit breaker
// ─────────────────────────────────────────────────────────────────────────────
describe('routeMessage with circuit breaker', () => {
  let routeMessage: (
    content: string,
    channelId: string,
    userName: string,
    sessionId?: string,
  ) => Promise<RouteResult[]>;
  let lockIntent: (sessionId: string, intent: string, reason: import('../../router/circuit_breaker').LockReason) => void;
  let _resetLockStore: () => void;
  let CIRCUIT_BREAKER_MESSAGE: string;
  let mockGenerateContent: ReturnType<typeof vi.fn>;
  let mockReadFileSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    // Set up fs mock — ENABLE_STRUCTURED_INTENT: true
    const fsModule = await import('fs');
    mockReadFileSync = vi.mocked(fsModule.readFileSync);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ ENABLE_STRUCTURED_INTENT: true }),
    );

    // Set up @google/genai mock — always returns ProposeTask with confidence 0.9
    const genaiModule = await import('@google/genai');
    mockGenerateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        intent: 'ProposeTask',
        confidenceScore: 0.9,
        targetAgent: 'product-manager',
        extractedEntities: {},
        reasoning: 'User wants to propose a task',
        needsCodeAccess: false,
        isStrategySession: false,
        requiresConfirmation: false,
      }),
    });
    vi.mocked(genaiModule.GoogleGenAI).mockImplementation(
      function () {
        return {
          models: {
            generateContent: mockGenerateContent,
          },
        } as any;
      },
    );

    // Import router and circuit breaker AFTER mocks are in place
    const router = await import('../index.js');
    routeMessage = router.routeMessage;

    const cb = await import('../circuit_breaker.js');
    lockIntent = cb.lockIntent;
    _resetLockStore = cb._resetLockStore;
    CIRCUIT_BREAKER_MESSAGE = cb.CIRCUIT_BREAKER_MESSAGE;

    // Ensure clean lock state
    _resetLockStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 10-turn test: turns 2-10 must all be circuit-broken
  // -------------------------------------------------------------------------
  it('10-turn: turns 2-10 return isCircuitBroken=true with hardcoded message', async () => {
    const sessionId = 'session-jimbob';

    // Turn 1: normal route (no lock yet)
    const [turn1] = await routeMessage('I want to create a task', 'channel-x', 'jimbob', sessionId);
    expect(turn1.isCircuitBroken).toBeFalsy();
    expect(turn1.isFallback).toBe(false);

    // Simulate downstream RBAC block — lock the intent
    lockIntent(sessionId, 'ProposeTask', 'rbac_rejection');

    // Turns 2-10: all must be circuit-broken
    for (let turn = 2; turn <= 10; turn++) {
      const [result] = await routeMessage(
        `Please, I really need this task created (attempt ${turn})`,
        'channel-x',
        'jimbob',
        sessionId,
      );
      expect(result.isCircuitBroken).toBe(true);
      expect(result.isFallback).toBe(true);
      expect(result.fallbackMessage).toBe(CIRCUIT_BREAKER_MESSAGE);
      // Hardcoded message must NOT be LLM-generated content
      expect(result.fallbackMessage).not.toContain('ProposeTask');
    }
  });

  it('10-turn: mock generateContent may be called for classification but fallbackMessage is never LLM output', async () => {
    const sessionId = 'session-llm-check';
    const llmPayload = JSON.stringify({
      intent: 'ProposeTask',
      confidenceScore: 0.9,
      targetAgent: 'product-manager',
      extractedEntities: {},
      reasoning: 'User wants to propose a task',
      needsCodeAccess: false,
      isStrategySession: false,
      requiresConfirmation: false,
    });
    mockGenerateContent.mockResolvedValue({ text: llmPayload });

    // Turn 1: normal
    await routeMessage('Create a task', 'channel-x', 'user', sessionId);
    lockIntent(sessionId, 'ProposeTask', 'rbac_rejection');

    // Turns 2-10: circuit broken — fallbackMessage must be hardcoded, not from LLM
    for (let turn = 2; turn <= 10; turn++) {
      const [result] = await routeMessage('I need that task', 'channel-x', 'user', sessionId);
      expect(result.fallbackMessage).toBe(
        'Security Policy Check: Request previously denied. Interaction terminated.',
      );
      expect(result.fallbackMessage).not.toBe(llmPayload);
    }
  });

  // -------------------------------------------------------------------------
  // Intent isolation: locked ProposeTask does not affect QueryKnowledge
  // -------------------------------------------------------------------------
  it('locked ProposeTask does not block QueryKnowledge in same session', async () => {
    const sessionId = 'session-intent-iso';

    mockGenerateContent
      .mockResolvedValueOnce({
        text: JSON.stringify({
          intent: 'ProposeTask',
          confidenceScore: 0.9,
          targetAgent: 'product-manager',
          extractedEntities: {},
          reasoning: 'propose',
          needsCodeAccess: false,
          isStrategySession: false,
          requiresConfirmation: false,
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          intent: 'QueryKnowledge',
          confidenceScore: 0.85,
          targetAgent: 'nexus',
          extractedEntities: {},
          reasoning: 'query',
          needsCodeAccess: false,
          isStrategySession: false,
          requiresConfirmation: false,
        }),
      });

    lockIntent(sessionId, 'ProposeTask', 'rbac_rejection');

    // ProposeTask should be blocked
    const [proposeResult] = await routeMessage('Create a task', 'channel-x', 'user', sessionId);
    expect(proposeResult.isCircuitBroken).toBe(true);

    // QueryKnowledge should pass through normally
    const [queryResult] = await routeMessage('What is the API?', 'channel-x', 'user', sessionId);
    expect(queryResult.isCircuitBroken).toBeFalsy();
    expect(queryResult.isFallback).toBe(false);
    expect(queryResult.agentId).toBe('nexus');
  });

  // -------------------------------------------------------------------------
  // Session isolation: locked session-1 does not affect session-2
  // -------------------------------------------------------------------------
  it('locked session-1:ProposeTask does not affect session-2:ProposeTask', async () => {
    lockIntent('session-1', 'ProposeTask', 'rbac_rejection');

    const [result] = await routeMessage('Create a task', 'channel-x', 'user', 'session-2');
    expect(result.isCircuitBroken).toBeFalsy();
    expect(result.isFallback).toBe(false);
    expect(result.agentId).toBe('product-manager');
  });

  // -------------------------------------------------------------------------
  // Legacy path: circuit breaker never fires when ENABLE_STRUCTURED_INTENT=false
  // -------------------------------------------------------------------------
  it('circuit breaker is never checked when ENABLE_STRUCTURED_INTENT is false', async () => {
    vi.resetModules();

    const fsModule = await import('fs');
    mockReadFileSync = vi.mocked(fsModule.readFileSync);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ ENABLE_STRUCTURED_INTENT: false }),
    );

    const genaiModule = await import('@google/genai');
    mockGenerateContent = vi.fn();
    vi.mocked(genaiModule.GoogleGenAI).mockImplementation(
      () =>
        ({
          models: { generateContent: mockGenerateContent },
        }) as unknown as InstanceType<typeof genaiModule.GoogleGenAI>,
    );

    const router = await import('../index.js');
    routeMessage = router.routeMessage;

    const cb = await import('../circuit_breaker.js');
    lockIntent = cb.lockIntent;
    _resetLockStore = cb._resetLockStore;
    _resetLockStore();

    // Lock an intent
    lockIntent('session-legacy', 'ProposeTask', 'rbac_rejection');

    const [result] = await routeMessage('Create a task', 'channel-x', 'user', 'session-legacy');

    // Legacy path returns intent: 'unstructured', no circuit break
    expect(result.intent).toBe('unstructured');
    expect(result.isCircuitBroken).toBeUndefined();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // logRoutingDecision is called for circuit-broken results
  // -------------------------------------------------------------------------
  it('logRoutingDecision is called for circuit-broken results', async () => {
    vi.resetModules();

    const fsModule = await import('fs');
    mockReadFileSync = vi.mocked(fsModule.readFileSync);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ ENABLE_STRUCTURED_INTENT: true }),
    );

    const genaiModule = await import('@google/genai');
    mockGenerateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        intent: 'ProposeTask',
        confidenceScore: 0.9,
        targetAgent: 'product-manager',
        extractedEntities: {},
        reasoning: 'propose',
        needsCodeAccess: false,
        isStrategySession: false,
        requiresConfirmation: false,
      }),
    });
    vi.mocked(genaiModule.GoogleGenAI).mockImplementation(
      function () {
        return { models: { generateContent: mockGenerateContent } } as any;
      },
    );

    // Re-import logger mock to capture calls
    const loggerModule = await import('../../telemetry/logger');
    const mockLogRoutingDecision = vi.mocked(loggerModule.logRoutingDecision);

    const router = await import('../index.js');
    routeMessage = router.routeMessage;

    const cb = await import('../circuit_breaker.js');
    lockIntent = cb.lockIntent;
    _resetLockStore = cb._resetLockStore;
    _resetLockStore();

    lockIntent('sess-log', 'ProposeTask', 'rbac_rejection');
    await routeMessage('Create task', 'channel-x', 'user', 'sess-log');

    expect(mockLogRoutingDecision).toHaveBeenCalledWith(
      expect.objectContaining({ isCircuitBroken: true }),
      expect.any(Number),
    );
  });
});
