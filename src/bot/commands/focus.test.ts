import '../../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../formatter.js', () => ({
  sendAgentMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../idle/allocator.js', () => ({
  getAllocationOverview: vi.fn().mockResolvedValue({ projects: [], dailyTotal: 0 }),
}));

vi.mock('../../idle/policy-resolver.js', () => ({
  resolveProjectPolicy: vi.fn().mockResolvedValue({ focusLevel: 'normal' }),
  setProjectPolicy: vi.fn().mockResolvedValue(undefined),
  getAllProjectPolicies: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../idle/suppression.js', () => ({
  getProjectSuppressionReport: vi.fn().mockResolvedValue({
    projectId: 'p1',
    suppressed: false,
    reasons: [],
    backpressure: 0,
    ticketsPerDay: 3,
    ticketsToday: 0,
    focusLevel: 'normal',
  }),
}));

vi.mock('../../settings/service.js', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../adapters/registry.js', () => ({
  getProjectRegistry: vi.fn().mockReturnValue({
    listProjects: vi.fn().mockResolvedValue([]),
    resolveProjectId: vi.fn().mockResolvedValue(undefined),
    resolveRepoKey: vi.fn().mockResolvedValue(undefined),
    resolveProjectSlug: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { handleFocusCommand, handleScheduleCommand } from './focus.js';

describe('handleFocusCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for non-focus messages (does not intercept normal messages)', async () => {
    expect(await handleFocusCommand('hello world', 'ch', 'org', 'user')).toBe(false);
    expect(await handleFocusCommand('!trigger', 'ch', 'org', 'user')).toBe(false);
    expect(await handleFocusCommand('!autonomous on', 'ch', 'org', 'user')).toBe(false);
    expect(await handleFocusCommand('!modes', 'ch', 'org', 'user')).toBe(false);
    expect(await handleFocusCommand('!public #general', 'ch', 'org', 'user')).toBe(false);
  });

  it('handles !focus (no args) — shows list', async () => {
    const result = await handleFocusCommand('!focus', 'ch', 'org', 'user');
    expect(result).toBe(true);
  });

  it('handles !focus list', async () => {
    const result = await handleFocusCommand('!focus list', 'ch', 'org', 'user');
    expect(result).toBe(true);
  });

  it('handles @nexus focus list (mention prefix)', async () => {
    const result = await handleFocusCommand('@nexus !focus list', 'ch', 'org', 'user');
    expect(result).toBe(true);
  });

  it('does NOT handle @permaship prefix (OSS — only @nexus)', async () => {
    // After OSS audit fix, @permaship should NOT be stripped
    const result = await handleFocusCommand('@permaship !focus list', 'ch', 'org', 'user');
    expect(result).toBe(false);
  });

  it('handles !focus <project> with too few args — shows usage', async () => {
    const { sendAgentMessage } = await import('../formatter.js');
    const result = await handleFocusCommand('!focus myproject', 'ch', 'org', 'user');
    expect(result).toBe(true);
    expect(sendAgentMessage).toHaveBeenCalledWith('ch', 'System', expect.stringContaining('Usage'), 'org');
  });

  it('handles !focus <project> <invalid_level> — shows error', async () => {
    // Mock finding the project via registry
    const { getProjectRegistry } = await import('../../adapters/registry.js');
    vi.mocked(getProjectRegistry).mockReturnValue({
      listProjects: vi.fn().mockResolvedValue([{ id: 'p1', name: 'My Project', slug: 'myproject' }]),
      resolveProjectId: vi.fn().mockResolvedValue('p1'),
      resolveRepoKey: vi.fn().mockResolvedValue(undefined),
      resolveProjectSlug: vi.fn().mockResolvedValue(undefined),
    });

    const { sendAgentMessage } = await import('../formatter.js');
    const result = await handleFocusCommand('!focus myproject banana', 'ch', 'org', 'user');
    expect(result).toBe(true);
    expect(sendAgentMessage).toHaveBeenCalledWith('ch', 'System', expect.stringContaining('Invalid'), 'org');
  });
});

describe('handleScheduleCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for non-schedule messages', async () => {
    expect(await handleScheduleCommand('hello', 'ch', 'org', 'user')).toBe(false);
    expect(await handleScheduleCommand('!focus list', 'ch', 'org', 'user')).toBe(false);
  });

  it('returns false for !schedule with too few args', async () => {
    expect(await handleScheduleCommand('!schedule', 'ch', 'org', 'user')).toBe(false);
    expect(await handleScheduleCommand('!schedule myproject', 'ch', 'org', 'user')).toBe(false);
  });
});
