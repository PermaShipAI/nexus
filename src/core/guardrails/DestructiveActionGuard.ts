export const DESTRUCTIVE_VERBS_PATTERN = /\b(delete|remove|purge|reset|unlink|drop|wipe)\b/i;
export const PROTECTED_RESOURCES_PATTERN = /\b(project|repo|repository|user|account)\b/i;

export type DestructiveActionResult =
  | { blocked: false }
  | { blocked: true; matchedPattern: string; message: string };

export function checkDestructiveAction(content: string, dashboardUrl: string): DestructiveActionResult {
  const verbMatch = DESTRUCTIVE_VERBS_PATTERN.exec(content);
  if (!verbMatch) {
    return { blocked: false };
  }

  const resourceMatch = PROTECTED_RESOURCES_PATTERN.exec(content);
  if (!resourceMatch) {
    return { blocked: false };
  }

  return {
    blocked: true,
    matchedPattern: `${verbMatch[0].toLowerCase()}:${resourceMatch[0].toLowerCase()}`,
    message: `For security reasons, destructive actions must be performed via the Dashboard: ${dashboardUrl}`,
  };
}
