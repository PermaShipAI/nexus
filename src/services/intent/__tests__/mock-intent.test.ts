import { describe, it, expect, afterEach } from "vitest";

// Store original env so we can restore it
const originalEnv = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
  // Reset to original first
  for (const key of ["NODE_ENV", "MOCK_INTENT_ENABLED", "MOCK_INTENT_VALUE"]) {
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

describe("getMockIntent", () => {
  afterEach(() => {
    // Restore environment
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    if (originalEnv.MOCK_INTENT_ENABLED !== undefined) {
      process.env.MOCK_INTENT_ENABLED = originalEnv.MOCK_INTENT_ENABLED;
    } else {
      delete process.env.MOCK_INTENT_ENABLED;
    }
    if (originalEnv.MOCK_INTENT_VALUE !== undefined) {
      process.env.MOCK_INTENT_VALUE = originalEnv.MOCK_INTENT_VALUE;
    } else {
      delete process.env.MOCK_INTENT_VALUE;
    }
  });

  it("returns null when NODE_ENV=production regardless of MOCK_INTENT_ENABLED", async () => {
    setEnv({
      NODE_ENV: "production",
      MOCK_INTENT_ENABLED: "true",
      MOCK_INTENT_VALUE: JSON.stringify({
        intent: "QueryKnowledge",
        confidence: 0.9,
        extractedEntities: {},
        targetAgent: "",
      }),
    });
    // Dynamic import to pick up env values — but since getMockIntent reads process.env at call time,
    // we can use a static import and call it directly.
    const { getMockIntent } = await import("../mock-intent.js");
    expect(getMockIntent()).toBeNull();
  });

  it("returns null when MOCK_INTENT_ENABLED is not 'true'", async () => {
    setEnv({
      NODE_ENV: "test",
      MOCK_INTENT_ENABLED: "false",
      MOCK_INTENT_VALUE: JSON.stringify({
        intent: "QueryKnowledge",
        confidence: 0.9,
        extractedEntities: {},
        targetAgent: "",
      }),
    });
    const { getMockIntent } = await import("../mock-intent.js");
    expect(getMockIntent()).toBeNull();
  });

  it("returns null when MOCK_INTENT_ENABLED is not set", async () => {
    setEnv({ NODE_ENV: "test" });
    const { getMockIntent } = await import("../mock-intent.js");
    expect(getMockIntent()).toBeNull();
  });

  it("returns null when MOCK_INTENT_VALUE is invalid JSON", async () => {
    setEnv({
      NODE_ENV: "test",
      MOCK_INTENT_ENABLED: "true",
      MOCK_INTENT_VALUE: "not-valid-json{{{",
    });
    const { getMockIntent } = await import("../mock-intent.js");
    expect(getMockIntent()).toBeNull();
  });

  it("returns null when MOCK_INTENT_VALUE is valid JSON but wrong shape", async () => {
    setEnv({
      NODE_ENV: "test",
      MOCK_INTENT_ENABLED: "true",
      MOCK_INTENT_VALUE: JSON.stringify({ foo: "bar" }),
    });
    const { getMockIntent } = await import("../mock-intent.js");
    expect(getMockIntent()).toBeNull();
  });

  it("returns null when confidence is out of range (> 1)", async () => {
    setEnv({
      NODE_ENV: "test",
      MOCK_INTENT_ENABLED: "true",
      MOCK_INTENT_VALUE: JSON.stringify({
        intent: "QueryKnowledge",
        confidence: 1.5,
        extractedEntities: {},
        targetAgent: "",
      }),
    });
    const { getMockIntent } = await import("../mock-intent.js");
    expect(getMockIntent()).toBeNull();
  });

  it("returns parsed value when env is set correctly with valid IntentResponse JSON", async () => {
    const mockData = {
      intent: "QueryKnowledge",
      confidence: 0.9,
      extractedEntities: { topic: "TypeScript" },
      targetAgent: "knowledge-agent",
    };
    setEnv({
      NODE_ENV: "test",
      MOCK_INTENT_ENABLED: "true",
      MOCK_INTENT_VALUE: JSON.stringify(mockData),
    });
    const { getMockIntent } = await import("../mock-intent.js");
    const result = getMockIntent();
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("QueryKnowledge");
    expect(result!.confidence).toBe(0.9);
    expect(result!.extractedEntities).toEqual({ topic: "TypeScript" });
    expect(result!.targetAgent).toBe("knowledge-agent");
  });

  it("returns parsed value with defaults for optional fields", async () => {
    const mockData = {
      intent: "ProposeTask",
      confidence: 0.8,
    };
    setEnv({
      NODE_ENV: "test",
      MOCK_INTENT_ENABLED: "true",
      MOCK_INTENT_VALUE: JSON.stringify(mockData),
    });
    const { getMockIntent } = await import("../mock-intent.js");
    const result = getMockIntent();
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("ProposeTask");
    expect(result!.confidence).toBe(0.8);
    expect(result!.extractedEntities).toEqual({});
    expect(result!.targetAgent).toBe("");
  });
});
