import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createPendingConfirmation,
  getPendingConfirmation,
  removePendingConfirmation,
  buildConfirmationPrompt,
  pendingConfirmationStore,
} from "../confirmation.js";

// Mock the telemetry logger so the cleanup interval doesn't cause issues
vi.mock("../../../agents/telemetry/logger.js", () => ({
  logger: { info: vi.fn() },
}));

describe("confirmation store", () => {
  beforeEach(() => {
    // Clear the in-memory store before each test
    pendingConfirmationStore.clear();
  });

  describe("createPendingConfirmation", () => {
    it("creates an entry with all correct fields", () => {
      const before = Date.now();
      const result = createPendingConfirmation({
        channelId: "ch1",
        userId: "u1",
        intent: "ProposeTask",
        extractedEntities: { project: "Alpha" },
        targetAgent: "task-agent",
        confirmationPrompt: "Do you want me to create a new task? [Confirm] [Cancel]",
      });
      const after = Date.now();

      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.channelId).toBe("ch1");
      expect(result.userId).toBe("u1");
      expect(result.intent).toBe("ProposeTask");
      expect(result.extractedEntities).toEqual({ project: "Alpha" });
      expect(result.targetAgent).toBe("task-agent");
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.expiresAt).toBeInstanceOf(Date);

      // expiresAt should be ~5 minutes after createdAt
      const diffMs = result.expiresAt.getTime() - result.createdAt.getTime();
      expect(diffMs).toBe(5 * 60 * 1000);

      // createdAt should be within the test window
      expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.createdAt.getTime()).toBeLessThanOrEqual(after);
    });

    it("stores the created confirmation so it can be retrieved", () => {
      const created = createPendingConfirmation({
        channelId: "ch2",
        userId: "u2",
        intent: "RequestReview",
        extractedEntities: {},
        targetAgent: "",
        confirmationPrompt: "Do you want me to request a review? [Confirm] [Cancel]",
      });

      expect(pendingConfirmationStore.has(created.id)).toBe(true);
    });
  });

  describe("getPendingConfirmation", () => {
    it("returns the created confirmation by id", () => {
      const created = createPendingConfirmation({
        channelId: "ch3",
        userId: "u3",
        intent: "ProposeTask",
        extractedEntities: {},
        targetAgent: "",
        confirmationPrompt: "Do you want me to create a new task? [Confirm] [Cancel]",
      });

      const retrieved = getPendingConfirmation(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.channelId).toBe("ch3");
      expect(retrieved!.userId).toBe("u3");
    });

    it("returns undefined for an unknown id", () => {
      expect(getPendingConfirmation("nonexistent-id")).toBeUndefined();
    });
  });

  describe("removePendingConfirmation", () => {
    it("removes the confirmation from the store", () => {
      const created = createPendingConfirmation({
        channelId: "ch4",
        userId: "u4",
        intent: "ProposeTask",
        extractedEntities: {},
        targetAgent: "",
        confirmationPrompt: "Do you want me to create a new task? [Confirm] [Cancel]",
      });

      expect(getPendingConfirmation(created.id)).toBeDefined();
      removePendingConfirmation(created.id);
      expect(getPendingConfirmation(created.id)).toBeUndefined();
    });

    it("does not throw when removing a nonexistent id", () => {
      expect(() => removePendingConfirmation("no-such-id")).not.toThrow();
    });
  });
});

describe("buildConfirmationPrompt", () => {
  it("formats correctly matching the required regex pattern", () => {
    const prompt = buildConfirmationPrompt("ProposeTask", {});
    expect(prompt).toMatch(/^Do you want me to .+\? \[Confirm\] \[Cancel\]$/);
  });

  it("formats ProposeTask without entities", () => {
    const prompt = buildConfirmationPrompt("ProposeTask", {});
    expect(prompt).toBe("Do you want me to create a new task? [Confirm] [Cancel]");
  });

  it("formats RequestReview without entities", () => {
    const prompt = buildConfirmationPrompt("RequestReview", {});
    expect(prompt).toBe("Do you want me to request a review? [Confirm] [Cancel]");
  });

  it("formats ProposeTask with an entity producing readable output", () => {
    const prompt = buildConfirmationPrompt("ProposeTask", { project: "Alpha" });
    expect(prompt).toMatch(/^Do you want me to .+\? \[Confirm\] \[Cancel\]$/);
    expect(prompt).toContain("Alpha");
    expect(prompt).toContain("create a new task");
  });

  it("uses the intent name as fallback for unknown intents", () => {
    const prompt = buildConfirmationPrompt("SomeUnknownIntent", {});
    expect(prompt).toBe("Do you want me to SomeUnknownIntent? [Confirm] [Cancel]");
  });

  it("formats AdministrativeAction without entities", () => {
    const prompt = buildConfirmationPrompt("AdministrativeAction", {});
    expect(prompt).toBe("Do you want me to change system settings? [Confirm] [Cancel]");
  });

  it("formats AdministrativeAction with setting entity", () => {
    const prompt = buildConfirmationPrompt("AdministrativeAction", { setting: "autonomous mode" });
    expect(prompt).toContain("change system settings");
    expect(prompt).toContain("autonomous mode");
  });
});
