import { logger } from '../logger.js';
import { logGuardrailEvent } from '../telemetry/index.js';

export const CONFLICT_WINDOW_MS = 60_000;
export const MAX_TRIPS_BEFORE_HALT = 5;

interface TripEntry {
  timestamp: number;
  toolName: string;
  httpStatus: number;
}

const tripStore = new Map<string, TripEntry[]>();

export function recordTrip(
  agentId: string,
  orgId: string,
  toolName: string,
  httpStatus: number,
): { shouldHalt: boolean } {
  const now = Date.now();
  const cutoff = now - CONFLICT_WINDOW_MS;

  const existing = (tripStore.get(agentId) ?? []).filter((e) => e.timestamp >= cutoff);
  existing.push({ timestamp: now, toolName, httpStatus });
  tripStore.set(agentId, existing);

  const tripCount = existing.length;
  const shouldHalt = tripCount >= MAX_TRIPS_BEFORE_HALT;

  logGuardrailEvent({
    event: 'agent_tool_409_circuit_breaker_tripped',
    agentId,
    orgId,
    toolName,
    httpStatus,
    tripCount,
    shouldHalt,
  });

  logger.warn(
    { agentId, orgId, toolName, httpStatus, tripCount, shouldHalt },
    'Tool 409 circuit breaker tripped',
  );

  return { shouldHalt };
}

export function isPersonaPaused(agentId: string): boolean {
  const now = Date.now();
  const cutoff = now - CONFLICT_WINDOW_MS;
  const trips = (tripStore.get(agentId) ?? []).filter((e) => e.timestamp >= cutoff);
  return trips.length >= MAX_TRIPS_BEFORE_HALT;
}

export function _resetForTesting(): void {
  tripStore.clear();
}
