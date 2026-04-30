import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the pino logger used by agents/telemetry/logger.ts
vi.mock("../../../agents/telemetry/logger.js", () => ({
  logger: { info: vi.fn() },
}));

import { logGuardrailEvent } from "../index.js";
import { logger } from "../../../agents/telemetry/logger.js";

describe("logGuardrailEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls logger.info with all fields for rbac_rejection event", () => {
    const event = {
      event: "rbac_rejection" as const,
      action: "create_ticket",
      requiredRole: "Project Manager",
      userId: "u1",
      channelId: "c1",
    };

    logGuardrailEvent(event);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(event);

    const callArg = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.event).toBe("rbac_rejection");
    expect(callArg.action).toBe("create_ticket");
    expect(callArg.requiredRole).toBe("Project Manager");
    expect(callArg.userId).toBe("u1");
    expect(callArg.channelId).toBe("c1");
  });

  it("calls logger.info for confirmation_gate_shown event", () => {
    const event = {
      event: "confirmation_gate_shown" as const,
      intent: "ProposeTask",
      channelId: "c2",
      userId: "u2",
      confirmationId: "conf-123",
    };

    logGuardrailEvent(event);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(event);

    const callArg = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.event).toBe("confirmation_gate_shown");
    expect(callArg.intent).toBe("ProposeTask");
    expect(callArg.channelId).toBe("c2");
    expect(callArg.userId).toBe("u2");
    expect(callArg.confirmationId).toBe("conf-123");
  });

  it("calls logger.info for confirmation_gate_confirmed event", () => {
    const event = {
      event: "confirmation_gate_confirmed" as const,
      intent: "ProposeTask",
      channelId: "c3",
      userId: "u3",
      confirmationId: "conf-456",
      elapsedMs: 1500,
    };

    logGuardrailEvent(event);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(event);
  });

  it("calls logger.info for confirmation_gate_dismissed event", () => {
    const event = {
      event: "confirmation_gate_dismissed" as const,
      intent: "RequestReview",
      channelId: "c4",
      userId: "u4",
      confirmationId: "conf-789",
      elapsedMs: 2000,
    };

    logGuardrailEvent(event);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(event);
  });

  it("calls logger.info for confirmation_gate_expired event", () => {
    const event = {
      event: "confirmation_gate_expired" as const,
      intent: "ProposeTask",
      confirmationId: "conf-expired",
    };

    logGuardrailEvent(event);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(event);
  });

  it("calls logger.info for ux_admin_intent_confirmation_displayed event", () => {
    const event = {
      event: "ux_admin_intent_confirmation_displayed" as const,
      intent: "AdministrativeAction",
      channelId: "c5",
      userId: "u5",
      confirmationId: "conf-admin-001",
    };

    logGuardrailEvent(event);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(event);
  });

  it("calls logger.info for administrative_intent_clarification_triggered event", () => {
    const event = {
      event: "administrative_intent_clarification_triggered" as const,
      channelId: "c6",
      userId: "u6",
      confidenceScore: 0.70,
      messageId: "msg-admin-001",
    };

    logGuardrailEvent(event);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(event);
  });
});
