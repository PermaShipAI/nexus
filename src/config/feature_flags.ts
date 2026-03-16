export interface FeatureFlags {
  ENABLE_STRUCTURED_INTENT: boolean;
  ENABLE_CONFIRMATION_GATES: boolean;
  ENABLE_PROCESSING_INDICATORS: boolean;
  INTENT_MODE: "structured" | "legacy_commands";
}

import { readFileSync } from "fs";
import { join } from "path";

export function getFeatureFlags(): FeatureFlags {
  const flagsPath = join(process.cwd(), "config", "feature_flags.json");
  const raw = readFileSync(flagsPath, "utf-8");
  return JSON.parse(raw) as FeatureFlags;
}
