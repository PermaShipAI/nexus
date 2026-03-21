import { join } from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db/index.js';
import { tickets } from '../db/schema.js';
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
import { getSetting } from '../settings/service.js';

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

  override async createTicket(
    input: CreateTicketInput,
  ): Promise<{ success: boolean; ticketId?: string; error?: string }> {
    const result = await super.createTicket(input);
    if (!result.success || !result.ticketId) return result;

    // Mark as running
    await db.update(tickets).set({
      executionStatus: 'running',
      executionBackend: this.backend.name,
    }).where(eq(tickets.id, result.ticketId));

    // Dispatch execution in background
    const ticketId = result.ticketId;
    this.dispatchExecution(ticketId, input).catch(async (err) => {
      logger.error({ err, ticketId }, 'Background execution dispatch failed');
      // Mark as failed so it's not stuck as 'running' forever
      await db.update(tickets).set({
        executionStatus: 'failed',
        executionOutput: `Dispatch error: ${(err as Error).message}`,
        executedAt: new Date(),
      }).where(eq(tickets.id, ticketId)).catch(() => {});
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

  /** Create a git worktree for isolated execution */
  private async createWorktree(repoPath: string, branchName: string): Promise<{ worktreePath: string; cleanup: () => Promise<void> }> {
    const worktreeDir = join(repoPath, '.nexus-worktrees');
    const worktreePath = join(worktreeDir, branchName);

    await execFileAsync('mkdir', ['-p', worktreeDir]);
    // Create an orphan-style worktree on a new branch
    await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: repoPath, timeout: 15_000 });

    logger.info({ repoPath, worktreePath, branchName }, 'Created git worktree for execution');

    const cleanup = async () => {
      try {
        await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, timeout: 15_000 });
        // Don't delete the branch — keep it for review
        logger.info({ worktreePath, branchName }, 'Cleaned up git worktree (branch preserved)');
      } catch (err) {
        logger.warn({ err, worktreePath }, 'Failed to clean up worktree');
      }
    };

    return { worktreePath, cleanup };
  }

  private async dispatchExecution(ticketId: string, input: CreateTicketInput): Promise<void> {
    // Resolve the actual local path from the project registry
    let repoPath: string;
    const registry = getProjectRegistry();
    if ('getProjectByRepoKey' in registry && typeof (registry as any).getProjectByRepoKey === 'function') {
      const project = await (registry as any).getProjectByRepoKey(input.repoKey, input.orgId);
      repoPath = project?.localPath ?? join(this.repoRoot, input.repoKey);
    } else {
      repoPath = join(this.repoRoot, input.repoKey);
    }

    // Check if worktree isolation is enabled
    const useWorktree = await getSetting('use_worktrees', input.orgId) === true;
    let execPath = repoPath;
    let worktreeCleanup: (() => Promise<void>) | null = null;
    let branchName: string | undefined;

    if (useWorktree) {
      try {
        branchName = `nexus/${ticketId.slice(0, 8)}-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
        const wt = await this.createWorktree(repoPath, branchName);
        execPath = wt.worktreePath;
        worktreeCleanup = wt.cleanup;
      } catch (err) {
        logger.warn({ err, repoPath }, 'Failed to create worktree — falling back to direct execution');
      }
    }

    logger.info({ ticketId, backend: this.backend.name, repoPath: execPath, useWorktree, title: input.title },
      'Dispatching ticket to execution backend');

    localBus.emit('message', {
      id: `exec-start-${ticketId}`,
      content: `**[System]** Dispatching ticket "${input.title}" to **${this.backend.name}**${useWorktree && branchName ? ` on branch \`${branchName}\`` : ''} in \`${execPath}\`...`,
      channel_id: LOCAL_CHANNEL_ID,
      timestamp: new Date().toISOString(),
    });

    const execResult = await this.backend.execute({
      ticketId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      repoPath: execPath,
      repoKey: input.repoKey,
    });

    if (branchName) execResult.branch = branchName;

    // Capture git diff of what changed
    const diff = await this.captureGitDiff(execPath);

    // Clean up worktree (branch is preserved for review)
    if (worktreeCleanup) await worktreeCleanup();

    // Store results in DB
    await db.update(tickets).set({
      executionStatus: execResult.success ? 'completed' : 'failed',
      executionBackend: this.backend.name,
      executionOutput: execResult.output?.slice(0, 50_000) ?? null,
      executionDiff: diff?.slice(0, 100_000) ?? null,
      executedAt: new Date(),
    }).where(eq(tickets.id, ticketId));

    // Notify UI
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

    const statusMsg = execResult.success
      ? `Successfully executed ticket: **${input.title}** via **${this.backend.name}**.${execResult.branch ? ` Branch: \`${execResult.branch}\`` : ''}`
      : `Failed to execute ticket: **${input.title}**. Error: ${stripAnsi(execResult.error ?? 'unknown error')}`;

    localBus.emit('message', {
      id: `exec-result-${ticketId}`,
      content: `**[System]** ${statusMsg}`,
      diff: diff ? diff.slice(0, 10_000) : null,
      embed_description: !diff && execResult.output ? stripAnsi(execResult.output).slice(0, 1500) : undefined,
      retry_ticket_id: execResult.success ? undefined : ticketId,
      channel_id: LOCAL_CHANNEL_ID,
      timestamp: new Date().toISOString(),
    });


    // Trigger agent review of the work
    if (execResult.success && diff) {
      await this.triggerReview(ticketId, input, diff, execResult);
    }

    logger.info({ ticketId, backend: this.backend.name, success: execResult.success },
      'Execution backend finished');
  }

  private async captureGitDiff(repoPath: string): Promise<string | null> {
    try {
      // Get diff of uncommitted changes + last commit diff
      const { stdout: staged } = await execFileAsync('git', ['diff', '--staged', '--stat'], { cwd: repoPath });
      const { stdout: unstaged } = await execFileAsync('git', ['diff', '--stat'], { cwd: repoPath });
      const { stdout: lastCommit } = await execFileAsync(
        'git', ['log', '-1', '--format=%H %s', '--name-status'],
        { cwd: repoPath },
      );

      // Get the actual diff content
      let diffContent = '';
      if (staged.trim() || unstaged.trim()) {
        const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], { cwd: repoPath });
        diffContent = stdout;
      } else if (lastCommit.trim()) {
        // Changes were already committed — diff against parent
        const { stdout } = await execFileAsync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: repoPath }).catch(() => ({ stdout: '' }));
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
          // Mark ticket as needing rework
          await db.update(tickets).set({ executionStatus: 'review_failed' }).where(eq(tickets.id, ticketId));

          // Notify with retry option
          localBus.emit('message', {
            id: `review-action-${ticketId}`,
            content: `**[System]** Code review outcome: **${reviewUpper.includes('REJECT') ? 'REJECTED' : 'NEEDS CHANGES'}**. The execution did not meet acceptance criteria for "${input.title}".`,
            retry_ticket_id: ticketId,
            channel_id: LOCAL_CHANNEL_ID,
            timestamp: new Date().toISOString(),
          });

          logger.info({ ticketId, outcome: reviewUpper.includes('REJECT') ? 'rejected' : 'needs_changes' }, 'Execution review: rework needed');
        } else if (reviewUpper.includes('APPROVE')) {
          await db.update(tickets).set({ executionStatus: 'review_approved' }).where(eq(tickets.id, ticketId));

          localBus.emit('message', {
            id: `review-approved-${ticketId}`,
            content: `**[System]** Code review **APPROVED** for "${input.title}". Changes are ready on the local branch.`,
            channel_id: LOCAL_CHANNEL_ID,
            timestamp: new Date().toISOString(),
          });

          logger.info({ ticketId }, 'Execution review: approved');
        }
      }
    } catch (err) {
      logger.warn({ err, ticketId }, 'Failed to trigger execution review');
    }
  }
}
