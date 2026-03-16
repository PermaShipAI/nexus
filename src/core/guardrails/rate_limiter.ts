export const COOLDOWN_MS = 60_000;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export class SettingsMutationRateLimiter {
  private readonly lastMutation = new Map<string, number>();

  check(key: string): RateLimitResult {
    const last = this.lastMutation.get(key);
    if (last === undefined) {
      return { allowed: true };
    }
    const elapsed = Date.now() - last;
    if (elapsed >= COOLDOWN_MS) {
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: COOLDOWN_MS - elapsed };
  }

  record(key: string): void {
    this.lastMutation.set(key, Date.now());
  }
}
