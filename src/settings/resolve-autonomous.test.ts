import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => {
  const selectResult = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(selectResult),
    },
  };
});

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { db } from '../db/index.js';
import { resolveAutonomousMode } from './service.js';

// Helper to mock the db.select chain for a specific call
function mockDbSelect(results: Array<Record<string, unknown>[]>) {
  let callIndex = 0;
  const mockLimit = vi.fn().mockImplementation(() => {
    return Promise.resolve(results[callIndex++] || []);
  });
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  vi.mocked(db.select).mockReturnValue({ from: mockFrom } as any);
}

describe('resolveAutonomousMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns mission override when mission has autonomousMode=true and global is false', async () => {
    // Call 1: mission lookup → true, Call 2: global setting lookup → false
    mockDbSelect([
      [{ autonomousMode: true }],  // mission
    ]);

    const result = await resolveAutonomousMode({
      orgId: 'org-1',
      channelId: 'mission:abc-123',
      repoKey: 'my-repo',
    });
    expect(result).toBe(true);
  });

  it('returns mission override false even when global is true', async () => {
    mockDbSelect([
      [{ autonomousMode: false }], // mission
    ]);

    const result = await resolveAutonomousMode({
      orgId: 'org-1',
      channelId: 'mission:abc-123',
    });
    expect(result).toBe(false);
  });

  it('falls through to project when mission autonomousMode is null', async () => {
    mockDbSelect([
      [{ autonomousMode: null }],  // mission (inherit)
      [{ autonomousMode: true }],  // project
    ]);

    const result = await resolveAutonomousMode({
      orgId: 'org-1',
      channelId: 'mission:abc-123',
      repoKey: 'my-repo',
    });
    expect(result).toBe(true);
  });

  it('falls through to global when both mission and project are null', async () => {
    mockDbSelect([
      [{ autonomousMode: null }],  // mission (inherit)
      [{ autonomousMode: null }],  // project (inherit)
      [{ value: true }],           // global setting
    ]);

    const result = await resolveAutonomousMode({
      orgId: 'org-1',
      channelId: 'mission:abc-123',
      repoKey: 'my-repo',
    });
    expect(result).toBe(true);
  });

  it('returns false when all levels are null/unset', async () => {
    mockDbSelect([
      [{ autonomousMode: null }],  // mission
      [{ autonomousMode: null }],  // project
      [],                           // no global setting
    ]);

    const result = await resolveAutonomousMode({
      orgId: 'org-1',
      channelId: 'mission:abc-123',
      repoKey: 'my-repo',
    });
    expect(result).toBe(false);
  });

  it('mission takes precedence over project', async () => {
    mockDbSelect([
      [{ autonomousMode: false }], // mission says off
    ]);

    const result = await resolveAutonomousMode({
      orgId: 'org-1',
      channelId: 'mission:abc-123',
      repoKey: 'my-repo',
    });
    // Should be false (mission wins) even though project might be true
    expect(result).toBe(false);
  });

  it('skips mission check for non-mission channelId', async () => {
    mockDbSelect([
      [{ autonomousMode: true }],  // project
    ]);

    const result = await resolveAutonomousMode({
      orgId: 'org-1',
      channelId: 'local:general',
      repoKey: 'my-repo',
    });
    // Should check project directly since channelId doesn't start with "mission:"
    expect(result).toBe(true);
  });

  it('falls back to global when no channelId or repoKey', async () => {
    mockDbSelect([
      [{ value: true }],  // global setting
    ]);

    const result = await resolveAutonomousMode({ orgId: 'org-1' });
    expect(result).toBe(true);
  });

  it('returns false when no channelId, no repoKey, and no global setting', async () => {
    mockDbSelect([
      [],  // no global setting
    ]);

    const result = await resolveAutonomousMode({ orgId: 'org-1' });
    expect(result).toBe(false);
  });
});
