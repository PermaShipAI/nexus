import { join } from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db/index.js';
import { tickets, pendingActions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import { LocalTicketTracker } from './ticket-tracker.js';
import type { CreateTicketInput } from '../adapters/interfaces/ticket-tracker.js';
import type { ExecutionBackend, ExecutionResult } from './execution-backends/index.js';
import { localBus } from './communication-adapter.js';
import { executeAgent } from '../agents/executor.js';
import { sendAgentMessage } from '../bot/formatter.js';
import { LOCAL_CHANNEL_ID } from './tenant-resolver.js';
import { getProjectRegistry } from '../adapters/registry.js';
import { getSetting, resolveAutonomousMode } from '../settings/service.js';
import { mergeTicketBranch, cleanupBranch, getMergeTargetBranch, queueMerge } from './branch-manager.js';

const execFileAsync = promisify(execFile);

/**
 * Extends LocalTicketTracker to dispatch approved tickets to a local
 * coding agent (Claude Code, Gemini CLI, Codex, OpenClaw, etc.)
 * and trigger an agent review of the results.
 */
export class LocalExecutingTicketTracker extends LocalTicketTracker {
  constructor(
    private backend: ExecutionBackend,
    private repoRoot: string,
  ) {
    super();
  }

  private activeExecutors = 0;
  private executionQueue: Array<{ ticketId: string; input: CreateTicketInput }> = [];

  /** Get the max concurrent executors setting (default 5) */
  private async getMaxConcurrency(orgId: string): Promise<number> {
    const val = await getSetting('max_executors', orgId);
    return typeof val === 'number' && val > 0 ? val : 5;
  }

  /** Try to dispatch the next queued ticket if there's capacity */
  private async processQueue(): Promise<void> {
    if (this.executionQueue.length === 0) return;

    const orgId = this.executionQueue[0]?.input.orgId;
    const maxConcurrency = orgId ? await this.getMaxConcurrency(orgId) : 5;
    if (this.activeExecutors >= maxConcurrency) return;

    const next = this.executionQueue.shift();
    if (!next) return;

    this.activeExecutors++;
    logger.info({ ticketId: next.ticketId, active: this.activeExecutors, queued: this.executionQueue.length }, 'Executor slot available — starting queued ticket');

    await db.update(tickets).set({
      executionStatus: 'running',
      executionBackend: this.backend.name,
    }).where(eq(tickets.id, next.ticketId));

    this.dispatchExecution(next.ticketId, next.input)
      .catch(async (err) => {
        logger.error({ err, ticketId: next.ticketId }, 'Background execution dispatch failed');
        await db.update(tickets).set({
          executionStatus: 'failed',
          executionOutput: `Dispatch error: ${(err as Error).message}`,
          executedAt: new Date(),
        }).where(eq(tickets.id, next.ticketId)).catch(() => {});
      })
      .finally(async () => {
        this.activeExecutors--;
        logger.info({ ticketId: next.ticketId, active: this.activeExecutors, queued: this.executionQueue.length }, 'Executor slot freed');
        await this.processQueue();
      });
  }

  override async createTicket(
    input: CreateTicketInput,
  ): Promise<{ success: boolean; ticketId?: string; error?: string }> {
    const result = await super.createTicket(input);
    if (!result.success || !result.ticketId) return result;

    const ticketId = result.ticketId;
    const maxConcurrency = await this.getMaxConcurrency(input.orgId);

    if (this.activeExecutors >= maxConcurrency) {
      // Queue it
      await db.update(tickets).set({
        executionStatus: 'queued',
        executionBackend: this.backend.name,
      }).where(eq(tickets.id, ticketId));
      this.executionQueue.push({ ticketId, input });
      logger.info({ ticketId, active: this.activeExecutors, queued: this.executionQueue.length, max: maxConcurrency }, 'Executor at capacity — ticket queued');
      return result;
    }

    // Dispatch immediately
    this.activeExecutors++;
    await db.update(tickets).set({
      executionStatus: 'running',
      executionBackend: this.backend.name,
    }).where(eq(tickets.id, ticketId));

    this.dispatchExecution(ticketId, input)
      .catch(async (err) => {
        logger.error({ err, ticketId }, 'Background execution dispatch failed');
        await db.update(tickets).set({
          executionStatus: 'failed',
          executionOutput: `Dispatch error: ${(err as Error).message}`,
          executedAt: new Date(),
        }).where(eq(tickets.id, ticketId)).catch(() => {});
      })
      .finally(async () => {
        this.activeExecutors--;
        logger.info({ ticketId, active: this.activeExecutors, queued: this.executionQueue.length }, 'Executor slot freed');
        await this.processQueue();
      });

    return result;
  }

  /** Recover tickets stuck in 'running' from a previous crash */
  async recoverZombieTickets(): Promise<void> {
    const zombies = await db.select({ id: tickets.id, title: tickets.title })
      .from(tickets)
      .where(eq(tickets.executionStatus as any, 'running'))
      .limit(50);

    if (zombies.length === 0) return;

    for (const z of zombies) {
      await db.update(tickets).set({
        executionStatus: 'failed',
        executionOutput: 'Recovered: execution was interrupted by a process restart.',
        executedAt: new Date(),
      }).where(eq(tickets.id, z.id));
      logger.warn({ ticketId: z.id, title: z.title }, 'Recovered zombie ticket from previous crash');
    }

    logger.info({ count: zombies.length }, 'Zombie ticket recovery complete');
  }

  async retryExecution(ticketId: string): Promise<{ success: boolean; error?: string }> {
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
    if (!ticket) return { success: false, error: 'Ticket not found' };
    if (ticket.executionStatus === 'running') return { success: false, error: 'Execution already running' };

    // Reset execution state
    await db.update(tickets).set({
      executionStatus: 'running',
      executionBackend: this.backend.name,
      executionOutput: null,
      executionDiff: null,
      executionReview: null,
      executedAt: null,
    }).where(eq(tickets.id, ticketId));

    // Re-dispatch in background
    const input: CreateTicketInput = {
      orgId: ticket.orgId,
      kind: ticket.kind as 'bug' | 'feature' | 'task',
      title: ticket.title,
      description: ticket.description,
      repoKey: ticket.repoKey,
      projectId: '',
      createdByAgentId: (ticket.createdByAgentId ?? undefined) as any,
    };

    this.dispatchExecution(ticketId, input).catch(err => {
      logger.error({ err, ticketId }, 'Retry execution dispatch failed');
    });

    return { success: true };
  }

  /** Create a git worktree for isolated execution.
   *  Handles stale branches/worktrees from previous crashes. */
  private async createWorktree(repoPath: string, branchName: string): Promise<{ worktreePath: string; cleanup: () => Promise<void> }> {
    const worktreeDir = join(repoPath, '.nexus-worktrees');
    const worktreePath = join(worktreeDir, branchName);

    await execFileAsync('mkdir', ['-p', worktreeDir]);

    // Prune stale worktrees from previous crashes
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoPath, timeout: 10_000 });
    } catch { /* ok */ }

    // Delete stale branch if it exists (leftover from a previous run)
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--list', branchName], { cwd: repoPath });
      if (stdout.trim()) {
        await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoPath, timeout: 10_000 });
        logger.info({ branchName }, 'Deleted stale branch before worktree creation');
      }
    } catch { /* branch doesn't exist — fine */ }

    // Remove leftover worktree directory from a previous crash
    try { await execFileAsync('rm', ['-rf', worktreePath]); } catch { /* ok */ }

    await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: repoPath, timeout: 15_000 });

    logger.info({ repoPath, worktreePath, branchName }, 'Created git worktree for execution');

    const cleanup = async () => {
      try {
        await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, timeout: 15_000 });
        logger.info({ worktreePath, branchName }, 'Cleaned up git worktree (branch preserved)');
      } catch (err) {
        logger.warn({ err, worktreePath }, 'Failed to clean up worktree');
      }
    };

    return { worktreePath, cleanup };
  }

  /** Find the mission channel for a ticket (if it originated from a mission) */
  private async findMissionChannel(ticketId: string, orgId: string): Promise<string | null> {
    try {
      // Look up the proposal that created this ticket
      const [action] = await db.select({ channelId: pendingActions.channelId })
        .from(pendingActions)
        .where(eq(pendingActions.orgId, orgId))
        .limit(50);
      // Actually need to match by title or check all approved actions
      const allActions = await db.select({ channelId: pendingActions.channelId, status: pendingActions.status })
        .from(pendingActions)
        .where(eq(pendingActions.orgId, orgId))
        .limit(100);
      const missionAction = allActions.find(a => a.channelId?.startsWith('mission:'));
      return missionAction?.channelId ?? null;
    } catch { return null; }
  }

  /** Emit a status message to both general and mission channels */
  private emitStatus(msg: { id: string; content: string; channel_id?: string; [key: string]: unknown }, missionChannelId: string | null) {
    localBus.emit('message', { ...msg, channel_id: LOCAL_CHANNEL_ID, timestamp: new Date().toISOString() });
    if (missionChannelId) {
      localBus.emit('message', { ...msg, id: msg.id + '-mission', channel_id: missionChannelId, timestamp: new Date().toISOString() });
    }
  }

  private async dispatchExecution(ticketId: string, input: CreateTicketInput): Promise<void> {
    // Find mission channel for status updates
    const missionChannel = await this.findMissionChannel(ticketId, input.orgId);

    // Resolve the actual local path from the project registry
    let repoPath: string;
    const registry = getProjectRegistry();
    if ('getProjectByRepoKey' in registry && typeof (registry as any).getProjectByRepoKey === 'function') {
      const project = await (registry as any).getProjectByRepoKey(input.repoKey, input.orgId);
      repoPath = project?.localPath ?? join(this.repoRoot, input.repoKey);
    } else {
      repoPath = join(this.repoRoot, input.repoKey);
    }

    // Always use worktree for isolated execution — no shared-directory fallback.
    // This prevents cross-contamination when multiple executors run concurrently.
    const branchName = `nexus/${ticketId.slice(0, 8)}-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
    const wt = await this.createWorktree(repoPath, branchName);
    const execPath = wt.worktreePath;
    const worktreeCleanup = wt.cleanup;

    // Record base commit before execution for scoped diff capture
    let baseCommit: string | undefined;
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: execPath, timeout: 5000 });
      baseCommit = stdout.trim();
    } catch { /* ok */ }

    logger.info({ ticketId, backend: this.backend.name, repoPath: execPath, branch: branchName, title: input.title },
      'Dispatching ticket to execution backend');

    this.emitStatus({
      id: `exec-start-${ticketId}`,
      content: `**[Executor]** Started: **${input.title}** via ${this.backend.name} (branch \`${branchName}\`)`,
    }, missionChannel);

    const execResult = await this.backend.execute({
      ticketId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      repoPath: execPath,
      repoKey: input.repoKey,
    });

    execResult.branch = branchName;

    // Capture git diff scoped to this executor's changes only
    const diff = await this.captureGitDiff(execPath, baseCommit);

    // Clean up worktree (branch is preserved for review/merge)
    await worktreeCleanup();

    // Store results in DB
    await db.update(tickets).set({
      executionStatus: execResult.success ? 'completed' : 'failed',
      executionBackend: this.backend.name,
      executionOutput: execResult.output?.slice(0, 50_000) ?? null,
      executionDiff: diff?.slice(0, 100_000) ?? null,
      executionBranch: execResult.branch ?? null,
      executedAt: new Date(),
    }).where(eq(tickets.id, ticketId));

    // Notify UI
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

    const statusMsg = execResult.success
      ? `Successfully executed ticket: **${input.title}** via **${this.backend.name}**.${execResult.branch ? ` Branch: \`${execResult.branch}\`` : ''}`
      : `Failed to execute ticket: **${input.title}**. Error: ${stripAnsi(execResult.error ?? 'unknown error')}`;

    this.emitStatus({
      id: `exec-result-${ticketId}`,
      content: execResult.success
        ? `**[Executor]** Completed: **${input.title}** — sending for review`
        : `**[Executor]** Failed: **${input.title}** — ${stripAnsi(execResult.error ?? 'unknown error')}`,
      diff: diff ? diff.slice(0, 10_000) : null,
      retry_ticket_id: execResult.success ? undefined : ticketId,
    }, missionChannel);


    // Trigger agent review of the work
    if (execResult.success && diff) {
      await this.triggerReview(ticketId, input, diff, execResult, repoPath);
    }

    logger.info({ ticketId, backend: this.backend.name, success: execResult.success },
      'Execution backend finished');
  }

  private async captureGitDiff(repoPath: string, baseCommit?: string): Promise<string | null> {
    try {
      let diffContent = '';

      // Check for uncommitted changes first
      const { stdout: staged } = await execFileAsync('git', ['diff', '--staged', '--stat'], { cwd: repoPath });
      const { stdout: unstaged } = await execFileAsync('git', ['diff', '--stat'], { cwd: repoPath });

      if (staged.trim() || unstaged.trim()) {
        const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], { cwd: repoPath });
        diffContent = stdout;
      }

      // If we have a known base commit, diff against it directly — this scopes
      // the diff to exactly the changes made by this executor, preventing
      // contamination from other concurrent executors
      if (baseCommit) {
        try {
          const { stdout } = await execFileAsync(
            'git', ['diff', baseCommit, 'HEAD'], { cwd: repoPath },
          );
          if (stdout.trim()) {
            diffContent = diffContent ? diffContent + '\n' + stdout : stdout;
          }
          return diffContent.trim() || null;
        } catch { /* fall through to merge-base approach */ }
      }

      // Fallback: diff against merge-base with main/master
      // This catches ALL commits on the branch, not just the last one
      for (const base of ['main', 'master']) {
        try {
          const { stdout: mergeBase } = await execFileAsync(
            'git', ['merge-base', base, 'HEAD'], { cwd: repoPath },
          );
          if (mergeBase.trim()) {
            const { stdout } = await execFileAsync(
              'git', ['diff', mergeBase.trim(), 'HEAD'], { cwd: repoPath },
            );
            if (stdout.trim()) {
              diffContent = diffContent ? diffContent + '\n' + stdout : stdout;
            }
            break; // Found a valid base
          }
        } catch { /* base branch doesn't exist, try next */ }
      }

      // Fallback: if no merge-base found (no main/master branch), diff from empty tree
      // This captures ALL changes in the repo — handles repos where the executor
      // created branches from the initial commit with no base branch to diff against
      if (!diffContent) {
        try {
          const { stdout: emptyTree } = await execFileAsync(
            'git', ['hash-object', '-t', 'tree', '/dev/null'], { cwd: repoPath },
          );
          if (emptyTree.trim()) {
            const { stdout } = await execFileAsync(
              'git', ['diff', emptyTree.trim(), 'HEAD'], { cwd: repoPath },
            );
            diffContent = stdout;
          }
        } catch { /* ok */ }
      }

      // Last resort: just the most recent commit
      if (!diffContent) {
        const { stdout } = await execFileAsync(
          'git', ['diff', 'HEAD~1', 'HEAD'], { cwd: repoPath },
        ).catch(() => ({ stdout: '' }));
        diffContent = stdout;
      }

      return diffContent.trim() || null;
    } catch (err) {
      logger.warn({ err, repoPath }, 'Failed to capture git diff');
      return null;
    }
  }

  private async triggerReview(
    ticketId: string,
    input: CreateTicketInput,
    diff: string,
    execResult: ExecutionResult,
    repoPath: string,
  ): Promise<void> {
    const reviewPrompt = `An execution backend (${this.backend.name}) has completed work on a ticket. Please review the changes and provide feedback.

## Ticket
**Title:** ${input.title}
**Kind:** ${input.kind}
**Description:** ${input.description}

## Execution Result
Status: ${execResult.success ? 'Success' : 'Failed'}
${execResult.branch ? `Branch: ${execResult.branch}` : ''}

## Git Diff (changes made)
\`\`\`diff
${diff.slice(0, 8000)}
\`\`\`
${diff.length > 8000 ? `\n(diff truncated — ${diff.length} chars total)` : ''}

## Review Instructions
1. Assess whether the changes correctly address the ticket requirements
2. Check for obvious bugs, security issues, or missing edge cases
3. Note anything that looks incomplete or needs follow-up work
4. Give your overall assessment: APPROVE, NEEDS_CHANGES, or REJECT

Keep your review concise and actionable.`;

    try {
      // Send to the agent who proposed the ticket for self-review,
      // or to qa-manager if available
      const reviewAgent = input.createdByAgentId === 'qa-manager' ? 'qa-manager' : (input.createdByAgentId || 'nexus');

      const review = await executeAgent({
        orgId: input.orgId,
        agentId: reviewAgent,
        channelId: LOCAL_CHANNEL_ID,
        userId: 'system',
        userName: 'Execution Review',
        userMessage: reviewPrompt,
        needsCodeAccess: false,
        source: 'idle',
      });

      if (review) {
        // Store the review in the ticket
        await db.update(tickets).set({ executionReview: review }).where(eq(tickets.id, ticketId));

        // Post the review to the UI
        await sendAgentMessage(LOCAL_CHANNEL_ID, 'Code Review', review, input.orgId);

        // Act on the review outcome
        const reviewUpper = review.toUpperCase();
        if (reviewUpper.includes('REJECT') || reviewUpper.includes('NEEDS_CHANGES')) {
          // Check if this is first failure — auto-retry once with review feedback
          const [ticket] = await db.select({ executionOutput: tickets.executionOutput })
            .from(tickets).where(eq(tickets.id, ticketId)).limit(1);
          const previouslyRetried = (ticket?.executionOutput ?? '').includes('[AUTO-RETRY]');

          if (!previouslyRetried) {
            // First failure — auto-retry with review feedback in a fresh worktree
            logger.info({ ticketId, title: input.title }, 'Review failed — auto-retrying with feedback');

            await db.update(tickets).set({
              executionStatus: 'running',
              executionOutput: `[AUTO-RETRY] Previous review feedback:\n${review.slice(0, 2000)}`,
              executionDiff: null,
              executionReview: null,
              executedAt: null,
            }).where(eq(tickets.id, ticketId));

            const reviewMissionCh = await this.findMissionChannel(ticketId, input.orgId);
            this.emitStatus({
              id: `auto-retry-${ticketId}`,
              content: `**[Executor]** Auto-retrying: **${input.title}** — incorporating review feedback`,
            }, reviewMissionCh);

            // Create a fresh worktree for the retry
            const retryBranch = `nexus/${ticketId.slice(0, 8)}-retry-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 35)}`;
            let retryExecPath: string;
            let retryCleanup: (() => Promise<void>) | null = null;
            let retryBaseCommit: string | undefined;

            try {
              const wt = await this.createWorktree(repoPath, retryBranch);
              retryExecPath = wt.worktreePath;
              retryCleanup = wt.cleanup;
              try {
                const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: retryExecPath, timeout: 5000 });
                retryBaseCommit = stdout.trim();
              } catch { /* ok */ }
            } catch (wtErr) {
              logger.error({ err: wtErr, ticketId }, 'Failed to create worktree for retry — marking as failed');
              await db.update(tickets).set({
                executionStatus: 'review_failed',
                executedAt: new Date(),
              }).where(eq(tickets.id, ticketId));
              return;
            }

            this.backend.execute({
              ticketId,
              kind: input.kind,
              title: input.title,
              description: `${input.description}\n\nPrevious review feedback:\n${review.slice(0, 1500)}`,
              repoPath: retryExecPath,
              repoKey: input.repoKey,
            }).then(async (retryResult) => {
              retryResult.branch = retryBranch;
              const retryDiff = await this.captureGitDiff(retryExecPath, retryBaseCommit);
              if (retryCleanup) await retryCleanup();

              await db.update(tickets).set({
                executionStatus: retryResult.success ? 'completed' : 'failed',
                executionOutput: `[AUTO-RETRY]\n${retryResult.output?.slice(0, 50_000) ?? ''}`,
                executionDiff: retryDiff?.slice(0, 100_000) ?? null,
                executionBranch: retryResult.branch ?? null,
                executedAt: new Date(),
              }).where(eq(tickets.id, ticketId));

              if (retryResult.success && retryDiff) {
                await this.triggerReview(ticketId, input, retryDiff, retryResult, repoPath);
              } else {
                const retryMissionCh = await this.findMissionChannel(ticketId, input.orgId);
                this.emitStatus({
                  id: `retry-failed-${ticketId}`,
                  content: `**[Executor]** Retry also failed: **${input.title}**`,
                  retry_ticket_id: ticketId,
                }, retryMissionCh);
              }
            }).catch(async (err) => {
              logger.error({ err, ticketId }, 'Auto-retry execution failed');
              if (retryCleanup) await retryCleanup();
              await db.update(tickets).set({
                executionStatus: 'failed',
                executedAt: new Date(),
              }).where(eq(tickets.id, ticketId));
            });

            return;
          }

          // Second failure (after retry) — mark as permanently failed
          await db.update(tickets).set({ executionStatus: 'review_failed' }).where(eq(tickets.id, ticketId));

          // Notify with retry option
          const reviewMissionCh = await this.findMissionChannel(ticketId, input.orgId);
          this.emitStatus({
            id: `review-action-${ticketId}`,
            content: `**[Review]** ${reviewUpper.includes('REJECT') ? 'REJECTED' : 'NEEDS CHANGES'}: **${input.title}**`,
            retry_ticket_id: ticketId,
          }, reviewMissionCh);

          logger.info({ ticketId, outcome: reviewUpper.includes('REJECT') ? 'rejected' : 'needs_changes' }, 'Execution review: rework needed');
        } else if (reviewUpper.includes('APPROVE')) {
          await db.update(tickets).set({ executionStatus: 'review_approved' }).where(eq(tickets.id, ticketId));
          const approveMissionCh = await this.findMissionChannel(ticketId, input.orgId);
          this.emitStatus({
            id: `review-approved-${ticketId}`,
            content: `**[Review]** APPROVED: **${input.title}** — code changes are ready`,
          }, approveMissionCh);

          const branchName = execResult.branch;
          const missionCh = await this.findMissionChannel(ticketId, input.orgId);
          const autonomous = await resolveAutonomousMode({
            orgId: input.orgId,
            channelId: missionCh ?? undefined,
            repoKey: input.repoKey,
          });

          if (autonomous && branchName) {
            // Queue for sequential merge — processes one at a time against
            // latest main to minimize conflicts from concurrent executors
            queueMerge(ticketId, input.orgId);
            const approveMissionCh2 = await this.findMissionChannel(ticketId, input.orgId);
            this.emitStatus({
              id: `merge-queued-${ticketId}`,
              content: `**[Merge]** Queued: **${input.title}** (branch \`${branchName}\`) — will merge sequentially`,
            }, approveMissionCh2);
          } else if (branchName) {
            // Non-autonomous: notify with merge button
            const targetBranch = repoPath ? await getMergeTargetBranch(input.orgId, repoPath) : 'main';
            localBus.emit('message', {
              id: `review-approved-${ticketId}`,
              content: `**[System]** Code review **APPROVED** for "${input.title}". Branch \`${branchName}\` is ready to merge.`,
              merge_ticket_id: ticketId,
              merge_target: targetBranch,
              channel_id: LOCAL_CHANNEL_ID,
              timestamp: new Date().toISOString(),
            });
          } else {
            localBus.emit('message', {
              id: `review-approved-${ticketId}`,
              content: `**[System]** Code review **APPROVED** for "${input.title}". Changes are ready.`,
              channel_id: LOCAL_CHANNEL_ID,
              timestamp: new Date().toISOString(),
            });
          }

          logger.info({ ticketId, autonomous, branchName }, 'Execution review: approved');
        }
      }
    } catch (err) {
      logger.warn({ err, ticketId }, 'Failed to trigger execution review');
    }
  }
}
