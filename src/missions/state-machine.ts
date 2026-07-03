/**
 * State machine for mission item lifecycle transitions.
 *
 * Valid transitions:
 *   pending        → in_progress
 *   in_progress    → agent_complete | in_progress  (self = heartbeat)
 *   agent_complete → verified | in_progress
 *   verified       → (terminal)
 *   waiting_for_human → (terminal — human must intervene)
 */

export const VALID_MISSION_ITEM_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending:            new Set(['in_progress']),
  in_progress:        new Set(['agent_complete', 'in_progress']),
  agent_complete:     new Set(['verified', 'in_progress']),
  verified:           new Set(),
  waiting_for_human:  new Set(),
};

export class StateTransitionError extends Error {
  public readonly itemId: string;
  public readonly fromStatus: string;
  public readonly toStatus: string;
  public readonly agentId: string | undefined;

  constructor(itemId: string, fromStatus: string, toStatus: string, agentId?: string) {
    super(
      `Invalid mission item state transition: item ${itemId} cannot go from '${fromStatus}' to '${toStatus}'${agentId ? ` (agent: ${agentId})` : ''}`,
    );
    this.name = 'StateTransitionError';
    this.itemId = itemId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
    this.agentId = agentId;
  }
}

/**
 * Asserts that a state transition is valid.
 * Throws StateTransitionError if the transition is not allowed.
 * No-op if valid.
 */
export function assertValidMissionItemTransition(
  itemId: string,
  from: string,
  to: string,
  agentId?: string,
): void {
  const allowed = VALID_MISSION_ITEM_TRANSITIONS[from];
  if (!allowed?.has(to)) {
    throw new StateTransitionError(itemId, from, to, agentId);
  }
}
