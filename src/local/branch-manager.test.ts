import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// execFile is callback-based; promisify(execFile) wraps it.
// We mock execFile to call its callback so the promisified version resolves.
// vi.hoisted is required because vi.mock factories are hoisted above variable declarations.
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('../db/index.js', () => {
  const mockSelectQuery = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    orderBy: vi.fn().mockReturnThis(),
  };
  const mockUpdateQuery = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(mockSelectQuery),
      update: vi.fn().mockReturnValue(mockUpdateQuery),
    },
  };
});

vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: vi.fn().mockReturnValue({}),
}));

vi.mock('../settings/service.js', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getMergeTargetBranch } from './branch-manager.js';
import { getSetting } from '../settings/service.js';

const mockGetSetting = getSetting as ReturnType<typeof vi.fn>;

/** Make execFile call its callback with a successful result */
function succeedWith(stdout: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string }) => void) => {
      callback(null, { stdout });
    },
  );
}

/** Make execFile call its callback with an error */
function failWith(message: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
      callback(new Error(message));
    },
  );
}

/** Make execFile succeed once then fail (for sequential calls) */
function succeedOnceThenFail() {
  let calls = 0;
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null, result?: { stdout: string }) => void) => {
      calls++;
      if (calls === 1) {
        callback(new Error('not found'));
      } else {
        callback(null, { stdout: '' });
      }
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSetting.mockResolvedValue(null);
});

describe('getMergeTargetBranch', () => {
  it('returns the configured branch when set in settings', async () => {
    mockGetSetting.mockResolvedValue('release/v2');

    const result = await getMergeTargetBranch('org-1', '/repo');

    expect(result).toBe('release/v2');
    // Should not invoke git when a configured branch exists
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('trims whitespace from configured branch name', async () => {
    mockGetSetting.mockResolvedValue('  develop  ');

    const result = await getMergeTargetBranch('org-1', '/repo');

    expect(result).toBe('develop');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('ignores empty string setting and falls back to git detection', async () => {
    mockGetSetting.mockResolvedValue('');
    succeedWith('');

    const result = await getMergeTargetBranch('org-1', '/repo');

    expect(result).toBe('main');
    expect(mockExecFile).toHaveBeenCalled();
  });

  it('auto-detects main when no branch is configured', async () => {
    mockGetSetting.mockResolvedValue(null);
    succeedWith('');

    const result = await getMergeTargetBranch('org-1', '/repo');

    expect(result).toBe('main');
  });

  it('auto-detects master when main branch does not exist', async () => {
    mockGetSetting.mockResolvedValue(null);
    succeedOnceThenFail();

    const result = await getMergeTargetBranch('org-1', '/repo');

    expect(result).toBe('master');
  });

  it('falls back to HEAD ref name when neither main nor master exist', async () => {
    mockGetSetting.mockResolvedValue(null);
    let calls = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null, result?: { stdout: string }) => void) => {
        calls++;
        if (calls <= 2) {
          callback(new Error('branch not found'));
        } else {
          callback(null, { stdout: 'trunk\n' });
        }
      },
    );

    const result = await getMergeTargetBranch('org-1', '/repo');

    expect(result).toBe('trunk');
  });

  it('returns main as ultimate fallback when all git operations fail', async () => {
    mockGetSetting.mockResolvedValue(null);
    failWith('git not available');

    const result = await getMergeTargetBranch('org-1', '/repo');

    expect(result).toBe('main');
  });
});
