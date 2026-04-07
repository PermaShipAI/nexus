export type InjectionCheckResult =
  | { detected: false }
  | { detected: true; matchedPattern: string };

export const INJECTION_PATTERNS: RegExp[] = [
  // DAN mode
  /\bdan\s+mode\b/i,
  // "do anything now"
  /\bdo\s+anything\s+now\b/i,
  // ignore-instructions variants
  /ignore\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|directives?)/i,
  // jailbreak keyword
  /\bjailbreak\b/i,
  // act-as / pretend-to-be
  /\b(act\s+as|pretend\s+to\s+be)\b/i,
  // override / disregard / bypass system prompt
  /\b(override|disregard|bypass)\b.*\b(system\s+prompt|instructions?|directives?)\b/i,
  // sudo / developer / god mode
  /\b(sudo|developer|god)\s+mode\b/i,
  // prompt-reveal: print / repeat / reveal system prompt
  /\b(print|repeat|reveal|show|display)\b.*\b(system\s+prompt|instructions?|directives?)\b/i,
  // XML tag injection targeting reserved tags
  /<\/?(system|instruction|prompt|user_input)\s*>/i,
  // "you are now" persona override
  /\byou\s+are\s+now\b/i,
];

export function checkForInjection(input: string): InjectionCheckResult {
  // Strip control characters (except tab \x09 and newline \x0A and CR \x0D).
  // eslint-disable-next-line no-control-regex
  const sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      return { detected: true, matchedPattern: pattern.toString() };
    }
  }

  return { detected: false };
}

/**
 * Sanitize untrusted indirect content (e.g. from the knowledge base, agent memories,
 * task titles, or mission descriptions) before injecting it into an LLM prompt.
 *
 * Unlike `checkForInjection` (which returns a detection result for direct user messages),
 * this function neutralises injection patterns in place so the surrounding content can
 * still be included in the prompt without abandoning the whole entry.
 */
export function sanitizeIndirectInput(text: string): string {
  // Strip control characters (except tab, LF, CR).
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Replace injection pattern matches with a safe placeholder.
  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex for patterns with the global flag (none here, but defensive).
    sanitized = sanitized.replace(new RegExp(pattern.source, pattern.flags), '[redacted]');
  }

  // Strip markdown headings that could override the surrounding prompt structure.
  sanitized = sanitized.replace(/^#{1,6}\s+/gm, '');

  // Collapse excessive blank lines.
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n');

  return sanitized.trim();
}
