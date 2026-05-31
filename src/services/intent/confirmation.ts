import { randomUUID } from "crypto";
import { logGuardrailEvent } from "../../telemetry/index.js";

export interface PendingConfirmation {
  id: string;
  channelId: string;
  userId: string;
  intent: string;
  extractedEntities: Record<string, unknown>;
  targetAgent: string;
  createdAt: Date;
  expiresAt: Date;
  confirmationPrompt: string;
}

const store = new Map<string, PendingConfirmation>();

export function createPendingConfirmation(params: {
  channelId: string;
  userId: string;
  intent: string;
  extractedEntities: Record<string, unknown>;
  targetAgent: string;
  confirmationPrompt: string;
}): PendingConfirmation {
  const id = randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
  const confirmation: PendingConfirmation = { id, ...params, createdAt, expiresAt };
  store.set(id, confirmation);
  return confirmation;
}

export function getPendingConfirmation(id: string): PendingConfirmation | undefined {
  return store.get(id);
}

export function removePendingConfirmation(id: string): void {
  store.delete(id);
}

export function buildConfirmationPrompt(intent: string, entities: Record<string, unknown>): string {
  const actionMap: Record<string, string> = {
    ProposeTask: "create a new task",
    RequestReview: "request a review",
    ManageProject: "modify project configuration",
    AccessSecrets: "access credentials or secrets",
    DestructiveAction: "perform a destructive operation",
    AdministrativeAction: `change system setting: ${entities.settingKey ?? 'unknown'} → ${entities.settingValue ?? 'unknown'}`,
  };
  const action = actionMap[intent] ?? intent;
  const details = intent === 'AdministrativeAction' ? '' : Object.values(entities).join(": ");
  const actionWithDetails = details ? `${action}: '${details}'` : action;
  if (intent === 'AdministrativeAction') {
    return `Are you sure you want to ${actionWithDetails}?`;
  }
  return `Do you want me to ${actionWithDetails}? [Confirm] [Cancel]`;
}

// TTL cleanup every 60 seconds
const cleanupInterval = setInterval(() => {
  const now = new Date();
  for (const [id, confirmation] of store.entries()) {
    if (confirmation.expiresAt <= now) {
      store.delete(id);
      logGuardrailEvent({
        event: "confirmation_gate_expired",
        intent: confirmation.intent,
        confirmationId: id,
      });
    }
  }
}, 60_000);

// Prevent interval from keeping process alive in tests
if (cleanupInterval.unref) cleanupInterval.unref();

// Export store for testing
export { store as pendingConfirmationStore };
