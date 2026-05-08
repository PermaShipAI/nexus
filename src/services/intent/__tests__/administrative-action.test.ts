import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../telemetry/index.js", () => ({
  logGuardrailEvent: vi.fn(),
}));

vi.mock("../../../../agents/telemetry/logger.js", () => ({
  logger: { info: vi.fn() },
}));

// Mock the intent classifier so routeIntent tests don't make live LLM calls
vi.mock("../../../intent/classifier.js", () => ({
  classifyIntent: vi.fn(),
}));

// Mock channel safety and RBAC to isolate router behaviour
vi.mock("../../../middleware/channel_safety.js", () => ({
  checkChannelSafety: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../rbac/checker.js", () => ({
  checkPermission: vi.fn().mockReturnValue({ allowed: true }),
}));

vi.mock("../../../intent/telemetry.js", () => ({
  logRoutingDecision: vi.fn(),
}));

import { buildConfirmationPrompt, pendingConfirmationStore, createPendingConfirmation } from "../confirmation.js";
import { routeIntent } from "../../../intent/router.js";
import { classifyIntent } from "../../../intent/classifier.js";
import { PERMISSION_MAP } from "../../../rbac/permission_map.js";
import { IntentKindEnum } from "../../../../agents/schemas/intent.js";
import { handleConfirm } from "../confirmation-handler.js";
import type { RequestContext } from "../../../rbac/types.js";

const baseContext: RequestContext = {
  platformUserId: "user-1",
  platform: "discord",
  channelType: "private",
  role: "ADMIN",
  messageId: "msg-1",
};

describe("AdministrativeAction — buildConfirmationPrompt", () => {
  it("returns a string containing settingKey and settingValue when both are provided", () => {
    const prompt = buildConfirmationPrompt("AdministrativeAction", {
      settingKey: "autonomous",
      settingValue: "enabled",
    });
    expect(prompt).toContain("autonomous");
    expect(prompt).toContain("enabled");
  });

  it("uses 'unknown' as value when settingValue is missing", () => {
    const prompt = buildConfirmationPrompt("AdministrativeAction", {
      settingKey: "publicMode",
    });
    expect(prompt).toContain("publicMode");
    expect(prompt).toContain("unknown");
  });

  it("falls back to generic prompt when settingKey is absent", () => {
    const prompt = buildConfirmationPrompt("AdministrativeAction", {});
    expect(prompt).toMatch(/^Do you want me to .+\? \[Confirm\] \[Cancel\]$/);
    expect(prompt).toContain("change system setting");
  });
});

describe("AdministrativeAction — routeIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { allowed: true, requiresConfirmation: true } when confidence >= 0.6", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      kind: "AdministrativeAction",
      confidenceScore: 0.8,
      params: { settingKey: "autonomous", settingValue: "enabled" },
    });

    const result = await routeIntent("enable autonomous mode", baseContext);

    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.intent?.kind).toBe("AdministrativeAction");
  });

  it("returns a low-confidence block result when confidence < 0.6", async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      kind: "AdministrativeAction",
      confidenceScore: 0.4,
      params: {},
    });

    const result = await routeIntent("do something adminny", baseContext);

    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe("LowConfidence");
  });
});

describe("AdministrativeAction — PERMISSION_MAP", () => {
  it("maps AdministrativeAction to ADMIN role", () => {
    expect(PERMISSION_MAP["AdministrativeAction"]).toBe("ADMIN");
  });
});

describe("AdministrativeAction — IntentKindEnum", () => {
  it("includes AdministrativeAction in options", () => {
    expect(IntentKindEnum.options).toContain("AdministrativeAction");
  });
});

describe("AdministrativeAction — handleConfirm identity mismatch", () => {
  beforeEach(() => {
    pendingConfirmationStore.clear();
    vi.clearAllMocks();
  });

  it("throws an error containing 'identity mismatch' when userId does not match", async () => {
    const confirmation = createPendingConfirmation({
      channelId: "ch1",
      userId: "real-user",
      intent: "AdministrativeAction",
      extractedEntities: { settingKey: "autonomous", settingValue: "enabled" },
      targetAgent: "nexus",
      confirmationPrompt: "Do you want me to set autonomous to enabled? [Confirm] [Cancel]",
    });

    const executor = vi.fn();
    await expect(
      handleConfirm(confirmation.id, executor, "attacker-user"),
    ).rejects.toThrow(/identity mismatch/i);
    expect(executor).not.toHaveBeenCalled();
  });
});
