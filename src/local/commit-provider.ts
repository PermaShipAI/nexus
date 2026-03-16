import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import type { CommitProvider } from '../adapters/interfaces/commit-provider.js';
import { LocalProjectRegistry } from './project-registry.js';

const execFileAsync = promisify(execFile);

export class LocalGitCommitProvider implements CommitProvider {
  constructor(private registry: LocalProjectRegistry) {}

  async fetchLatestCommit(
    orgId: string,
    repoKey: string,
  ): Promise<{ sha: string; date: string } | null> {
    const project = await this.registry.getProjectByRepoKey(repoKey, orgId);
    if (!project) return null;

    try {
      const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%H %aI'], {
        cwd: project.localPath,
      });
      const [sha, date] = stdout.trim().split(' ');
      if (!sha || !date) return null;
      return { sha, date };
    } catch (err) {
      logger.warn({ err, repoKey }, 'Failed to get latest commit from local git');
      return null;
    }
  }

  async fetchCommitsSince(
    orgId: string,
    repoKey: string,
    since: string,
  ): Promise<Array<{ sha: string; files: string[] }> | null> {
    const project = await this.registry.getProjectByRepoKey(repoKey, orgId);
    if (!project) return null;

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', `--since=${since}`, '--format=%H', '--name-only', '--max-count=200'],
        { cwd: project.localPath },
      );

      if (!stdout.trim()) return [];

      // Parse git log output: SHA on one line, followed by file paths, separated by blank lines
      const commits: Array<{ sha: string; files: string[] }> = [];
      const blocks = stdout.trim().split('\n\n');

      for (const block of blocks) {
        const lines = block.trim().split('\n').filter(l => l.length > 0);
        if (lines.length === 0) continue;
        const sha = lines[0];
        const files = lines.slice(1);
        commits.push({ sha, files });
      }

      return commits;
    } catch (err) {
      logger.warn({ err, repoKey }, 'Failed to get commits since date from local git');
      return null;
    }
  }
}
