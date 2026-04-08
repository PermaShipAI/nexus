import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock prom-client so tests run without the real dependency
vi.mock('prom-client', () => {
  class Registry {
    contentType = 'text/plain';
    metrics = vi.fn(async () => '');
    register = vi.fn();
  }

  class Counter {
    inc = vi.fn();
  }

  class Histogram {
    observe = vi.fn();
  }

  const collectDefaultMetrics = vi.fn();

  return { Registry, Counter, Histogram, collectDefaultMetrics };
});

// Must import AFTER the mock is registered
import {
  routingRequestsTotal,
  routingLatencyMs,
  routingConfidenceScore,
  routingInjectionBlockedTotal,
} from '../prometheus.js';

describe('routing Prometheus metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routingRequestsTotal.inc accepts routing label set', () => {
    routingRequestsTotal.inc({
      intent: 'InvestigateBug',
      agent_id: 'sre',
      is_fallback: 'false',
      is_circuit_broken: 'false',
    });
    expect(routingRequestsTotal.inc).toHaveBeenCalledOnce();
  });

  it('routingLatencyMs.observe records latency with labels', () => {
    routingLatencyMs.observe({ intent: 'ProposeTask', is_fallback: 'false' }, 123);
    expect(routingLatencyMs.observe).toHaveBeenCalledWith(
      { intent: 'ProposeTask', is_fallback: 'false' },
      123,
    );
  });

  it('routingConfidenceScore.observe records score per intent', () => {
    routingConfidenceScore.observe({ intent: 'QueryKnowledge' }, 0.85);
    expect(routingConfidenceScore.observe).toHaveBeenCalledWith({ intent: 'QueryKnowledge' }, 0.85);
  });

  it('routingInjectionBlockedTotal.inc increments on injection block', () => {
    routingInjectionBlockedTotal.inc();
    expect(routingInjectionBlockedTotal.inc).toHaveBeenCalledOnce();
  });
});
