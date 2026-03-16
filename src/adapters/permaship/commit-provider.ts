import { fetchLatestCommit, fetchCommitsSince } from '../../permaship/client.js';
import type { CommitProvider } from '../interfaces/commit-provider.js';

export class PermashipCommitProvider implements CommitProvider {
  async fetchLatestCommit(
    orgId: string,
    repoKey: string,
  ): Promise<{ sha: string; date: string } | null> {
    return fetchLatestCommit(orgId, repoKey);
  }

  async fetchCommitsSince(
    orgId: string,
    repoKey: string,
    since: string,
  ): Promise<Array<{ sha: string; files: string[] }> | null> {
    return fetchCommitsSince(orgId, repoKey, since);
  }
}
