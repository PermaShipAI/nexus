import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock paths are resolved relative to THIS test file:
//   src/services/intent/__tests__/
//
// confirmation-handler.ts imports "../../telemetry/index.js"
//   => resolves to src/telemetry/index.js
//   => from __tests__/ that is ../../../telemetry/index.js
//
// confirmation.ts imports "../../telemetry/index.js"  (same target)

vi.mock("../../../telemetry/index.js", () => ({
  logGuardrailEvent: vi.fn(),
}));

// Mock the pino logger used by the confirmation store's cleanup interval
vi.mock("../../../../agents/telemetry/logger.js", () => ({
  logger: { info: vi.fn() },
}));

import { handleConfirm, handleCancel } from "../confirmation-handler.js";
import {
  createPendingConfirmation,
  pendingConfirmationStore,
} from "../confirmation.js";
import { ConfirmationNotFoundError } from "../errors.js";
// Import logGuardrailEvent using the same resolved path as the vi.mock above
import { logGuardrailEvent } from "../../../telemetry/index.js";

describe("handleConfirm", () => {
  beforeEach(() => {
    pendingConfirmationStore.clear();
    vi.clearAllMocks();
  });

  it("calls the executor with the confirmation and returns its result", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch1",
      userId: "u1",
      intent: "ProposeTask",
      extractedEntities: {},
      targetAgent: "task-agent",
      confirmationPrompt: "Do you want me to create a new task? [Confirm] [Cancel]",
    });

    const expectedResult = [{ agentId: "task-agent", intent: "ProposeTask", confidence: 1.0 }];
    const executor = vi.fn().mockResolvedValue(expectedResult);

    const result = await handleConfirm(confirmation.id, executor, "u1");

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(confirmation);
    expect(result).toEqual(expectedResult);
  });

  it("logs confirmation_gate_confirmed with numeric elapsedMs", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch1",
      userId: "u1",
      intent: "ProposeTask",
      extractedEntities: {},
      targetAgent: "",
      confirmationPrompt: "Do you want me to create a new task? [Confirm] [Cancel]",
    });

    const executor = vi.fn().mockResolvedValue([]);
    await handleConfirm(confirmation.id, executor, "u1");

    expect(logGuardrailEvent).toHaveBeenCalledOnce();
    const callArg = (logGuardrailEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.event).toBe("confirmation_gate_confirmed");
    expect(typeof callArg.elapsedMs).toBe("number");
    expect(callArg.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("throws ConfirmationNotFoundError for unknown ID without calling executor", async () => {
    const executor = vi.fn();
    await expect(handleConfirm("unknown-id", executor, "u1")).rejects.toThrow(ConfirmationNotFoundError);
    expect(executor).not.toHaveBeenCalled();
  });

  it("removes the confirmation from the store after confirming", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch1",
      userId: "u1",
      intent: "ProposeTask",
      extractedEntities: {},
      targetAgent: "",
      confirmationPrompt: "Do you want me to create a new task? [Confirm] [Cancel]",
    });

    const executor = vi.fn().mockResolvedValue([]);
    await handleConfirm(confirmation.id, executor, "u1");

    expect(pendingConfirmationStore.has(confirmation.id)).toBe(false);
  });

  it("rejects confirmation from a different user", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch1",
      userId: "u1",
      intent: "ProposeTask",
      extractedEntities: {},
      targetAgent: "task-agent",
      confirmationPrompt: "Confirm?",
    });

    const executor = vi.fn();
    await expect(
      handleConfirm(confirmation.id, executor, "attacker-user"),
    ).rejects.toThrow("User identity mismatch");
    expect(executor).not.toHaveBeenCalled();
    // Confirmation must remain in store for the legitimate user
    expect(pendingConfirmationStore.has(confirmation.id)).toBe(true);
  });

  it("logs confirmation_identity_mismatch on userId mismatch", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch1",
      userId: "u1",
      intent: "ProposeTask",
      extractedEntities: {},
      targetAgent: "task-agent",
      confirmationPrompt: "Confirm?",
    });

    const executor = vi.fn();
    try {
      await handleConfirm(confirmation.id, executor, "attacker-user");
    } catch { /* expected */ }

    expect(logGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "confirmation_identity_mismatch",
        expectedUserId: "u1",
        actualUserId: "attacker-user",
        confirmationId: confirmation.id,
      }),
    );
  });

  it("allows the legitimate user to confirm after a mismatch rejection", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch1",
      userId: "u1",
      intent: "ProposeTask",
      extractedEntities: {},
      targetAgent: "task-agent",
      confirmationPrompt: "Confirm?",
    });

    const attackerExecutor = vi.fn();
    try {
      await handleConfirm(confirmation.id, attackerExecutor, "attacker-user");
    } catch { /* expected */ }

    // Legitimate user can still confirm
    const legitimateExecutor = vi.fn().mockResolvedValue([{ agentId: "task-agent" }]);
    const result = await handleConfirm(confirmation.id, legitimateExecutor, "u1");
    expect(legitimateExecutor).toHaveBeenCalledOnce();
    expect(result).toEqual([{ agentId: "task-agent" }]);
  });
});

describe("handleCancel", () => {
  beforeEach(() => {
    pendingConfirmationStore.clear();
    vi.clearAllMocks();
  });

  it("logs confirmation_gate_dismissed with numeric elapsedMs", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch2",
      userId: "u2",
      intent: "RequestReview",
      extractedEntities: {},
      targetAgent: "",
      confirmationPrompt: "Do you want me to request a review? [Confirm] [Cancel]",
    });

    await handleCancel(confirmation.id);

    expect(logGuardrailEvent).toHaveBeenCalledOnce();
    const callArg = (logGuardrailEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.event).toBe("confirmation_gate_dismissed");
    expect(typeof callArg.elapsedMs).toBe("number");
    expect(callArg.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("throws ConfirmationNotFoundError for unknown ID", async () => {
    await expect(handleCancel("unknown-id")).rejects.toThrow(ConfirmationNotFoundError);
  });

  it("removes the entry so a subsequent call throws", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch3",
      userId: "u3",
      intent: "ProposeTask",
      extractedEntities: {},
      targetAgent: "",
      confirmationPrompt: "Do you want me to create a new task? [Confirm] [Cancel]",
    });

    await handleCancel(confirmation.id);

    // Second call should throw because entry was removed
    await expect(handleCancel(confirmation.id)).rejects.toThrow(ConfirmationNotFoundError);
  });

  it("removes the confirmation from the store after cancelling", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch4",
      userId: "u4",
      intent: "ProposeTask",
      extractedEntities: {},
      targetAgent: "",
      confirmationPrompt: "Do you want me to create a new task? [Confirm] [Cancel]",
    });

    await handleCancel(confirmation.id);
    expect(pendingConfirmationStore.has(confirmation.id)).toBe(false);
  });
});
