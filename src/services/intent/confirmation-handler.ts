import { getPendingConfirmation, removePendingConfirmation, PendingConfirmation } from "./confirmation.js";
import { ConfirmationNotFoundError } from "./errors.js";
import { logGuardrailEvent } from "../../telemetry/index.js";

export type RouteExecutor = (confirmation: PendingConfirmation) => Promise<RouteResult[]>;

// RouteResult defined locally here (will be extended by agents/types/routing.ts)
export interface RouteResult {
  agentId?: string;
  intent?: string;
  confidence?: number;
  requiresConfirmation?: boolean;
  confirmationId?: string;
  confirmationPrompt?: string;
  [key: string]: unknown;
}

export async function handleConfirm(confirmationId: string, executor: RouteExecutor): Promise<RouteResult[]> {
  const confirmation = getPendingConfirmation(confirmationId);
  if (!confirmation) {
    throw new ConfirmationNotFoundError();
  }
  removePendingConfirmation(confirmationId);
  const elapsedMs = Date.now() - confirmation.createdAt.getTime();
  logGuardrailEvent({
    event: "confirmation_gate_confirmed",
    intent: confirmation.intent,
    channelId: confirmation.channelId,
    userId: confirmation.userId,
    confirmationId,
    elapsedMs,
  });
  return executor(confirmation);
}

export async function handleCancel(confirmationId: string): Promise<void> {
  const confirmation = getPendingConfirmation(confirmationId);
  if (!confirmation) {
    throw new ConfirmationNotFoundError();
  }
  removePendingConfirmation(confirmationId);
  const elapsedMs = Date.now() - confirmation.createdAt.getTime();
  logGuardrailEvent({
    event: "confirmation_gate_dismissed",
    intent: confirmation.intent,
    channelId: confirmation.channelId,
    userId: confirmation.userId,
    confirmationId,
    elapsedMs,
  });
}
