import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db/index.js';
import { tickets } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import { getProjectRegistry } from '../adapters/registry.js';
import { getSetting } from '../settings/service.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000;

export interface MergeResult {
  success: boolean;
  reason?: 'dirty_worktree' | 'conflict' | 'branch_not_found' | 'already_merged' | 'error';
  conflictFiles?: string[];
  error?: string;
}

export interface BranchInfo {
  ticketId: string;
  title: string;
  branch: string;
  repoKey: string;
  executionStatus: string | null;
  mergeStatus: string | null;
  executedAt: Date | null;
  createdAt: Date;
}

/** Detect the default branch for a repo */
async function detectDefaultBranch(repoPath: string): Promise<string> {
  for (const candidate of ['main', 'master']) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', candidate], { cwd: repoPath, timeout: GIT_TIMEOUT });
      return candidate;
    } catch { /* try next */ }
  }
  // Fallback: whatever HEAD points to
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, timeout: GIT_TIMEOUT });
    return stdout.trim();
  } catch {
    return 'main';
  }
}

/** Get the configured merge target branch, or detect it */
export async function getMergeTargetBranch(orgId: string, repoPath: string): Promise<string> {
  const configured = await getSetting('merge_target_branch', orgId);
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return detectDefaultBranch(repoPath);
}

/** Resolve repo path from repoKey */
async function resolveRepoPath(repoKey: string, orgId: string): Promise<string | null> {
  const registry = getProjectRegistry();
  if ('getProjectByRepoKey' in registry && typeof (registry as any).getProjectByRepoKey === 'function') {
    const project = await (registry as any).getProjectByRepoKey(repoKey, orgId);
    return project?.localPath ?? null;
  }
  return null;
}

/** Merge a branch into the target branch */
export async function mergeBranch(
  ticketId: string,
  repoPath: string,
  branchName: string,
  targetBranch?: string,
): Promise<MergeResult> {
  try {
    // Check branch exists
    try {
      await execFileAsync('git', ['rev-parse', '--verify', branchName], { cwd: repoPath, timeout: GIT_TIMEOUT });
    } catch {
      await db.update(tickets).set({ mergeStatus: 'branch_gone' }).where(eq(tickets.id, ticketId));
      return { success: false, reason: 'branch_not_found' };
    }

    const target = targetBranch ?? await detectDefaultBranch(repoPath);

    // Save current branch
    const { stdout: currentBranch } = await execFileAsync(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, timeout: GIT_TIMEOUT },
    );
    const originalBranch = currentBranch.trim();

    // Check if already on target, if not checkout
    if (originalBranch !== target) {
      // Check for dirty worktree
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoPath, timeout: GIT_TIMEOUT });
      if (status.trim()) {
        return { success: false, reason: 'dirty_worktree' };
      }
      await execFileAsync('git', ['checkout', target], { cwd: repoPath, timeout: GIT_TIMEOUT });
    }

    // Attempt merge
    try {
      // Get ticket title for merge commit message
      const [ticket] = await db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
      const commitMsg = `Merge ${branchName}: ${ticket?.title ?? 'executed ticket'}`;

      await execFileAsync('git', ['merge', branchName, '--no-ff', '-m', commitMsg], { cwd: repoPath, timeout: GIT_TIMEOUT });

      // Success
      await db.update(tickets).set({ mergeStatus: 'merged' }).where(eq(tickets.id, ticketId));
      logger.info({ ticketId, branchName, target }, 'Branch merged successfully');
      return { success: true };
    } catch {
      // Merge conflict — abort and restore
      let conflictFiles: string[] = [];

      try {
        const { stdout: conflictStatus } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoPath, timeout: GIT_TIMEOUT });
        conflictFiles = conflictStatus.trim().split('\n').filter(Boolean);
      } catch { /* ok */ }

      await execFileAsync('git', ['merge', '--abort'], { cwd: repoPath, timeout: GIT_TIMEOUT }).catch(() => {});

      // Restore original branch
      if (originalBranch !== target) {
        await execFileAsync('git', ['checkout', originalBranch], { cwd: repoPath, timeout: GIT_TIMEOUT }).catch(() => {});
      }

      await db.update(tickets).set({ mergeStatus: 'conflict' }).where(eq(tickets.id, ticketId));
      logger.warn({ ticketId, branchName, conflictFiles }, 'Branch merge conflict');
      return { success: false, reason: 'conflict', conflictFiles };
    }
  } catch (err) {
    logger.error({ err, ticketId, branchName }, 'Branch merge failed');
    await db.update(tickets).set({ mergeStatus: 'failed' }).where(eq(tickets.id, ticketId));
    return { success: false, reason: 'error', error: (err as Error).message };
  }
}

/** Delete a merged branch */
export async function cleanupBranch(repoPath: string, branchName: string): Promise<void> {
  try {
    await execFileAsync('git', ['branch', '-d', branchName], { cwd: repoPath, timeout: GIT_TIMEOUT });
    logger.info({ branchName }, 'Cleaned up merged branch');
  } catch (err) {
    logger.warn({ err, branchName }, 'Failed to clean up branch');
  }
}

/** List all branches with ticket data */
export async function listBranches(orgId: string): Promise<BranchInfo[]> {
  const rows = await db.select({
    ticketId: tickets.id,
    title: tickets.title,
    branch: tickets.executionBranch,
    repoKey: tickets.repoKey,
    executionStatus: tickets.executionStatus,
    mergeStatus: tickets.mergeStatus,
    executedAt: tickets.executedAt,
    createdAt: tickets.createdAt,
  }).from(tickets).where(
    eq(tickets.orgId, orgId),
  ).limit(100);

  // Only return tickets that have a branch
  return rows.filter(r => r.branch != null).map(r => ({
    ...r,
    branch: r.branch!,
  }));
}

/** Merge a ticket's branch by ticketId (resolves repo path automatically) */
export async function mergeTicketBranch(ticketId: string, orgId: string): Promise<MergeResult> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!ticket) return { success: false, reason: 'error', error: 'Ticket not found' };
  if (!ticket.executionBranch) return { success: false, reason: 'branch_not_found' };
  if (ticket.mergeStatus === 'merged') return { success: false, reason: 'already_merged' };

  const repoPath = await resolveRepoPath(ticket.repoKey, orgId);
  if (!repoPath) return { success: false, reason: 'error', error: 'Project not found for repo key' };

  const targetBranch = await getMergeTargetBranch(orgId, repoPath);
  return mergeBranch(ticketId, repoPath, ticket.executionBranch, targetBranch);
}
