/**
 * Safely parse pending_actions.args, handling both:
 * - Proper JSONB objects (JS object)
 * - Double-serialized JSONB strings (JS string that needs JSON.parse)
 */
export function parseArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof args === 'object') return args as Record<string, unknown>;
  return {};
}
