import '../tests/env.js';
import { describe, it, expect } from 'vitest';
import {
  getEffectiveTicketsPerDay,
  isWithinOperatingWindow,
  parseScheduleShorthand,
  FOCUS_TICKETS_PER_DAY,
  DEFAULT_PROJECT_POLICY,
  type OperatingWindow,
} from './project-policy.js';

describe('getEffectiveTicketsPerDay', () => {
  it('returns correct values for standard focus levels', () => {
    expect(getEffectiveTicketsPerDay({ focusLevel: 'off' })).toBe(0);
    expect(getEffectiveTicketsPerDay({ focusLevel: 'low' })).toBe(1);
    expect(getEffectiveTicketsPerDay({ focusLevel: 'normal' })).toBe(3);
    expect(getEffectiveTicketsPerDay({ focusLevel: 'high' })).toBe(8);
  });

  it('returns custom value for custom focus level', () => {
    expect(getEffectiveTicketsPerDay({ focusLevel: 'custom', customTicketsPerDay: 5 })).toBe(5);
  });

  it('falls back to normal when custom has no customTicketsPerDay', () => {
    expect(getEffectiveTicketsPerDay({ focusLevel: 'custom' })).toBe(FOCUS_TICKETS_PER_DAY.normal);
  });

  it('DEFAULT_PROJECT_POLICY returns normal tickets/day', () => {
    expect(getEffectiveTicketsPerDay(DEFAULT_PROJECT_POLICY)).toBe(3);
  });
});

describe('isWithinOperatingWindow', () => {
  it('returns true when window is null (no restriction)', () => {
    expect(isWithinOperatingWindow(null)).toBe(true);
  });

  it('returns true when window is undefined', () => {
    expect(isWithinOperatingWindow(undefined)).toBe(true);
  });

  it('returns true when window has empty windows array', () => {
    expect(isWithinOperatingWindow({ timezone: 'UTC', windows: [] })).toBe(true);
  });

  it('returns true for a window covering all days 0-24', () => {
    const window: OperatingWindow = {
      timezone: 'UTC',
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }],
    };
    expect(isWithinOperatingWindow(window)).toBe(true);
  });

  it('returns false for a window with no matching days', () => {
    // Use a day that is definitely not today — day 7 doesn't exist
    // Instead, use a window with hours 25-26 which can never match
    const window: OperatingWindow = {
      timezone: 'UTC',
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 25, endHour: 26 }],
    };
    expect(isWithinOperatingWindow(window)).toBe(false);
  });

  it('handles invalid timezone gracefully (falls back to local time)', () => {
    const window: OperatingWindow = {
      timezone: 'Invalid/Timezone',
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }],
    };
    expect(isWithinOperatingWindow(window)).toBe(true);
  });
});

describe('parseScheduleShorthand', () => {
  it('returns null for "always" (removes restriction)', () => {
    expect(parseScheduleShorthand('always')).toBeNull();
  });

  it('parses "weekdays" as Mon-Fri 0-24', () => {
    const result = parseScheduleShorthand('weekdays', 'America/New_York');
    expect(result).toEqual({
      timezone: 'America/New_York',
      windows: [{ days: [1, 2, 3, 4, 5], startHour: 0, endHour: 24 }],
    });
  });

  it('parses "weekdays 9-17" with hours', () => {
    const result = parseScheduleShorthand('weekdays 9-17');
    expect(result).toEqual({
      timezone: 'UTC',
      windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }],
    });
  });

  it('parses "weekends" as Sat/Sun 0-24', () => {
    const result = parseScheduleShorthand('weekends');
    expect(result).toEqual({
      timezone: 'UTC',
      windows: [{ days: [0, 6], startHour: 0, endHour: 24 }],
    });
  });

  it('parses bare "9-17" as daily hours', () => {
    const result = parseScheduleShorthand('9-17');
    expect(result).toEqual({
      timezone: 'UTC',
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 9, endHour: 17 }],
    });
  });

  it('returns null for unparseable input', () => {
    expect(parseScheduleShorthand('gibberish')).toBeNull();
    expect(parseScheduleShorthand('')).toBeNull();
  });
});
