// src/idle/project-policy.ts — Per-project policy model and operating window evaluation

export type FocusLevel = 'off' | 'low' | 'normal' | 'high' | 'custom';

export interface ProjectPolicy {
  focusLevel: FocusLevel;
  customTicketsPerDay?: number;       // only when focusLevel === 'custom'
  operatingWindow?: OperatingWindow | null; // null = inherit org
  autonomousMode?: boolean | null;    // null = inherit org
}

export interface OperatingWindow {
  timezone: string;       // IANA timezone e.g. 'America/New_York'
  windows: WeeklyWindow[];
}

export interface WeeklyWindow {
  days: number[];   // 0=Sun..6=Sat
  startHour: number;
  endHour: number;
}

export const FOCUS_TICKETS_PER_DAY: Record<Exclude<FocusLevel, 'custom'>, number> = {
  off: 0,
  low: 1,
  normal: 3,
  high: 8,
};

export const DEFAULT_PROJECT_POLICY: ProjectPolicy = {
  focusLevel: 'normal',
};

/** Get effective tickets/day for a policy */
export function getEffectiveTicketsPerDay(policy: ProjectPolicy): number {
  if (policy.focusLevel === 'custom') {
    return policy.customTicketsPerDay ?? FOCUS_TICKETS_PER_DAY.normal;
  }
  return FOCUS_TICKETS_PER_DAY[policy.focusLevel];
}

/** Check if the current time falls within an operating window */
export function isWithinOperatingWindow(window: OperatingWindow | null | undefined): boolean {
  if (!window || !window.windows || window.windows.length === 0) return true; // no restriction

  const now = new Date();
  let currentDay: number;
  let currentHour: number;

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: window.timezone,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const weekdayPart = parts.find(p => p.type === 'weekday')?.value ?? '';
    const hourPart = parts.find(p => p.type === 'hour')?.value ?? '0';

    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    currentDay = dayMap[weekdayPart] ?? now.getDay();
    currentHour = parseInt(hourPart, 10);
    if (isNaN(currentHour)) currentHour = now.getHours();
  } catch {
    // Fallback to local time if timezone is invalid
    currentDay = now.getDay();
    currentHour = now.getHours();
  }

  for (const w of window.windows) {
    if (!w.days.includes(currentDay)) continue;
    if (currentHour >= w.startHour && currentHour < w.endHour) return true;
  }

  return false;
}

/** Parse a schedule shorthand into an OperatingWindow */
export function parseScheduleShorthand(input: string, timezone = 'UTC'): OperatingWindow | null {
  const lower = input.trim().toLowerCase();

  if (lower === 'always') return null; // remove restriction

  const weekdays = [1, 2, 3, 4, 5];
  const weekends = [0, 6];
  const allDays = [0, 1, 2, 3, 4, 5, 6];

  // Parse "weekdays 9-17" or "weekdays"
  const match = lower.match(/^(weekdays|weekends|daily)\s*(?:(\d{1,2})-(\d{1,2}))?$/);
  if (match) {
    const dayGroup = match[1];
    const startHour = match[2] ? parseInt(match[2], 10) : 0;
    const endHour = match[3] ? parseInt(match[3], 10) : 24;
    const days = dayGroup === 'weekdays' ? weekdays : dayGroup === 'weekends' ? weekends : allDays;
    return { timezone, windows: [{ days, startHour, endHour }] };
  }

  // Parse bare "9-17"
  const hourMatch = lower.match(/^(\d{1,2})-(\d{1,2})$/);
  if (hourMatch) {
    return {
      timezone,
      windows: [{ days: allDays, startHour: parseInt(hourMatch[1], 10), endHour: parseInt(hourMatch[2], 10) }],
    };
  }

  return null; // unparseable
}
