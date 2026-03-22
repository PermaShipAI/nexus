import { logger } from "../../agents/telemetry/logger.js";

export type GuardrailEvent =
  | { event: "confirmation_gate_shown"; intent: string; channelId: string; userId: string; confirmationId: string }
  | { event: "confirmation_gate_confirmed"; intent: string; channelId: string; userId: string; confirmationId: string; elapsedMs: number }
  | { event: "confirmation_gate_dismissed"; intent: string; channelId: string; userId: string; confirmationId: string; elapsedMs: number }
  | { event: "confirmation_gate_expired"; intent: string; confirmationId: string }
  | { event: "rbac_rejection"; action: string; requiredRole: string; userId: string; channelId: string }
  | { event: "destructive_action_blocked"; userId: string; channelId: string; orgId: string; matchedPattern: string }
  | { event: "confirmation_identity_mismatch"; confirmationId: string; expectedUserId: string; actualUserId: string; channelId: string; intent: string }
  | { event: "proposal_rejected_human"; proposalId: string; agentId: string; orgId: string; reason: string; details?: string }
  | { event: "agentops_evaluation_triggered"; orgId: string; windowDays: number; topFailureClasses: Array<{ reason: string; count: number }> }
  | { event: "agentops_adr_draft_triggered"; orgId: string; agentId: string; reason: string; rejectionCount: number };

export function logGuardrailEvent(event: GuardrailEvent): void {
  logger.info(event);
}
