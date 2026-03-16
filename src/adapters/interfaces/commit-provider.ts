export interface CommitProvider {
  fetchLatestCommit(
    orgId: string,
    repoKey: string,
  ): Promise<{ sha: string; date: string } | null>;

  fetchCommitsSince(
    orgId: string,
    repoKey: string,
    since: string,
  ): Promise<Array<{ sha: string; files: string[] }> | null>;
}
