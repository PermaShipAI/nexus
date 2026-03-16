import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitProvider } from '../interfaces/commit-provider.js';

const execFileAsync = promisify(execFile);

/**
 * Git-based commit provider for standalone use.
 * Uses local git repositories to fetch commit information.
 */
export class GitCommitProvider implements CommitProvider {
  private repoRoot: string;

  constructor(repoRoot?: string) {
    this.repoRoot = repoRoot ?? process.cwd();
  }

  async fetchLatestCommit(
    _orgId: string,
    _repoKey: string,
  ): Promise<{ sha: string; date: string } | null> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', '-1', '--format=%H %aI'],
        { cwd: this.repoRoot },
      );
      const [sha, date] = stdout.trim().split(' ');
      if (!sha || !date) return null;
      return { sha, date };
    } catch {
      return null;
    }
  }

  async fetchCommitsSince(
    _orgId: string,
    _repoKey: string,
    since: string,
  ): Promise<Array<{ sha: string; files: string[] }> | null> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', `--since=${since}`, '--format=%H', '--name-only'],
        { cwd: this.repoRoot },
      );

      const commits: Array<{ sha: string; files: string[] }> = [];
      let current: { sha: string; files: string[] } | null = null;

      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (current) commits.push(current);
          current = null;
          continue;
        }
        if (/^[0-9a-f]{40}$/.test(trimmed)) {
          if (current) commits.push(current);
          current = { sha: trimmed, files: [] };
        } else if (current) {
          current.files.push(trimmed);
        }
      }
      if (current) commits.push(current);

      return commits;
    } catch {
      return null;
    }
  }
}
