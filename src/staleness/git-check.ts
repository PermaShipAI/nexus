import { db } from '../db/index.js';
import { codebaseSnapshots } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getCommitProvider } from '../adapters/registry.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface FileContext {
  repoKey: string;
  filePaths: string[];
  commitSha?: string;
}

/**
 * Check whether any files related to a proposal have been modified since it was created.
 * Returns 'changed', 'unchanged', or 'unknown' (if API unavailable).
 */
export async function checkGitStaleness(
  orgId: string,
  fileContext: FileContext,
  createdAt: Date,
): Promise<'changed' | 'unchanged' | 'unknown'> {
  const { repoKey, filePaths } = fileContext;

  if (filePaths.length === 0) return 'unknown';

  const commits = await getCommitProvider().fetchCommitsSince(orgId, repoKey, createdAt.toISOString());
  if (commits === null) return 'unknown';
  if (commits.length === 0) return 'unchanged';

  // Check if any commit touches any of the proposal's file paths
  const normalizedPaths = new Set(filePaths.map((p) => p.replace(/^\//, '')));

  for (const commit of commits) {
    for (const file of commit.files) {
      const normalizedFile = file.replace(/^\//, '');
      if (normalizedPaths.has(normalizedFile)) return 'changed';
      // Also check if a commit file is a parent directory or vice versa
      for (const proposalPath of normalizedPaths) {
        if (normalizedFile.startsWith(proposalPath) || proposalPath.startsWith(normalizedFile)) {
          return 'changed';
        }
      }
    }
  }

  return 'unchanged';
}

/**
 * Compute adaptive TTL based on commit frequency.
 * High-activity repos get shorter TTLs; quiet repos get longer ones.
 */
export function getAdaptiveTtlDays(commitFrequency: number | null): number {
  if (commitFrequency === null) return config.STALENESS_DEFAULT_TTL_DAYS;
  if (commitFrequency > 10) return 2;
  if (commitFrequency >= 3) return 5;
  if (commitFrequency > 0) return 10;
  return config.STALENESS_DEFAULT_TTL_DAYS;
}

/**
 * Fetch latest commit + calculate commit frequency, then upsert into codebaseSnapshots.
 */
export async function updateRepoSnapshot(orgId: string, repoKey: string): Promise<void> {
  try {
    const latestCommit = await getCommitProvider().fetchLatestCommit(orgId, repoKey);
    if (!latestCommit) return;

    // Estimate commit frequency: count commits in last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentCommits = await getCommitProvider().fetchCommitsSince(orgId, repoKey, thirtyDaysAgo.toISOString());
    const commitFrequency = recentCommits ? recentCommits.length / 30 : null;

    // Upsert
    const existing = await db
      .select()
      .from(codebaseSnapshots)
      .where(and(eq(codebaseSnapshots.orgId, orgId), eq(codebaseSnapshots.repoKey, repoKey)))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(codebaseSnapshots)
        .set({
          latestCommitSha: latestCommit.sha,
          commitFrequency,
          checkedAt: new Date(),
        })
        .where(and(eq(codebaseSnapshots.orgId, orgId), eq(codebaseSnapshots.repoKey, repoKey)));
    } else {
      await db.insert(codebaseSnapshots).values({
        orgId,
        repoKey,
        latestCommitSha: latestCommit.sha,
        commitFrequency,
      });
    }

    logger.debug({ orgId, repoKey, commitFrequency }, 'Repo snapshot updated');
  } catch (err) {
    logger.warn({ err, orgId, repoKey }, 'Failed to update repo snapshot');
  }
}

/**
 * Get the commit frequency for a given repo from the snapshot cache.
 */
export async function getRepoCommitFrequency(
  orgId: string,
  repoKey: string,
): Promise<number | null> {
  const [snapshot] = await db
    .select()
    .from(codebaseSnapshots)
    .where(and(eq(codebaseSnapshots.orgId, orgId), eq(codebaseSnapshots.repoKey, repoKey)))
    .limit(1);

  return snapshot?.commitFrequency ?? null;
}
