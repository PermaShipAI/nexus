/**
 * Mission item state machine.
 *
 * Valid status transitions for mission items:
 *
 *   pending        → in_progress
 *   in_progress    → agent_complete | in_progress (self, heartbeat)
 *   agent_complete → verified | in_progress (reopen)
 *   verified       → (terminal)
 *
 * Any other transition is illegal and will throw StateTransitionError.
 */

export type MissionItemStatus =
  | 'pending'
  | 'in_progress'
  | 'agent_complete'
  | 'verified';

const VALID_TRANSITIONS: Record<MissionItemStatus, ReadonlySet<MissionItemStatus>> = {
  pending:        new Set(['in_progress']),
  in_progress:    new Set(['agent_complete', 'in_progress']),
  agent_complete: new Set(['verified', 'in_progress']),
  verified:       new Set(),
};

export class StateTransitionError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(
      `Invalid mission item state transition for ${itemId}: '${from}' → '${to}'`,
    );
    this.name = 'StateTransitionError';
  }
}

/**
 * Assert that transitioning a mission item from `from` to `to` is legal.
 * Throws StateTransitionError if not.
 *
 * Pass-through when `from` is null/undefined (new items with no prior status).
 */
export function assertValidMissionItemTransition(
  itemId: string,
  from: string | null | undefined,
  to: string,
): void {
  if (!from) return; // new item, no prior status to validate against

  const allowed = VALID_TRANSITIONS[from as MissionItemStatus];
  if (allowed === undefined) {
    // Unknown current status — do not block (forward-compat)
    return;
  }
  if (!allowed.has(to as MissionItemStatus)) {
    throw new StateTransitionError(itemId, from, to);
  }
}
