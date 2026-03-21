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

export async function handleConfirm(confirmationId: string, executor: RouteExecutor, userId: string): Promise<RouteResult[]> {
  const confirmation = getPendingConfirmation(confirmationId);
  if (!confirmation) {
    throw new ConfirmationNotFoundError();
  }

  // PF-001: Validate that the confirming user matches the original requester
  if (confirmation.userId !== userId) {
    logGuardrailEvent({
      event: "confirmation_identity_mismatch",
      confirmationId,
      expectedUserId: confirmation.userId,
      actualUserId: userId,
      channelId: confirmation.channelId,
      intent: confirmation.intent,
    });
    throw new Error("User identity mismatch: you cannot confirm another user's action");
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
