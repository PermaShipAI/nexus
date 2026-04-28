import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

/**
 * Singleton Prometheus registry for Nexus Command routing metrics.
 *
 * Exposes the following instruments:
 *   nexus_routing_requests_total          – counter per intent/agent/fallback/circuit-broken
 *   nexus_routing_latency_ms              – histogram of LLM classification latency
 *   nexus_routing_confidence_score        – histogram of confidence values per intent
 *   nexus_routing_injection_blocked_total – counter of prompt-injection blocks
 *   nexus_confirmation_gate_total         – counter of confirmation gate events by intent/outcome
 *   nexus_confirmation_resolution_latency_ms – histogram of time between gate shown and resolved
 */

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'nexus_process_' });

export const routingRequestsTotal = new Counter({
  name: 'nexus_routing_requests_total',
  help: 'Total number of routing decisions processed',
  labelNames: ['intent', 'agent_id', 'is_fallback', 'is_circuit_broken'] as const,
  registers: [registry],
});

export const routingLatencyMs = new Histogram({
  name: 'nexus_routing_latency_ms',
  help: 'End-to-end latency of the intent classification step in milliseconds',
  labelNames: ['intent', 'is_fallback'] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

export const routingConfidenceScore = new Histogram({
  name: 'nexus_routing_confidence_score',
  help: 'Distribution of intent confidence scores (0–1)',
  labelNames: ['intent'] as const,
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [registry],
});

export const routingInjectionBlockedTotal = new Counter({
  name: 'nexus_routing_injection_blocked_total',
  help: 'Total number of requests blocked by the prompt-injection guardrail',
  labelNames: [] as const,
  registers: [registry],
});

export const confirmationGateTotal = new Counter({
  name: 'nexus_confirmation_gate_total',
  help: 'Total number of manual confirmation gate events',
  labelNames: ['intent', 'outcome'] as const,
  registers: [registry],
});

export const confirmationResolutionLatencyMs = new Histogram({
  name: 'nexus_confirmation_resolution_latency_ms',
  help: 'Time between confirmation gate shown and user resolution (confirm/cancel) in milliseconds',
  labelNames: ['intent', 'outcome'] as const,
  buckets: [1000, 5000, 10000, 30000, 60000, 120000, 300000],
  registers: [registry],
});

export const agentStatusUpdate409Total = new Counter({
  name: 'telemetry_agent_status_update_409_total',
  help: 'Total 409 state conflict intercepts from agent update_task_status calls',
  labelNames: ['agent_id'] as const,
  registers: [registry],
});
