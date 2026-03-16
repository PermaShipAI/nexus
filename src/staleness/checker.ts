import { db } from '../db/index.js';
import { pendingActions, workspaceLinks } from '../db/schema.js';
import { and, eq, or, isNull, lte } from 'drizzle-orm';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { executeAgent } from '../agents/executor.js';
import { sendAgentMessage } from '../bot/formatter.js';
import {
  checkGitStaleness,
  getAdaptiveTtlDays,
  getRepoCommitFrequency,
  updateRepoSnapshot,
} from './git-check.js';
import type { FileContext } from './git-check.js';
import type { AgentId } from '../agents/types.js';
import { getProjectRegistry, getTicketTracker } from '../adapters/registry.js';
import type { Suggestion } from '../adapters/interfaces/ticket-tracker.js';

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

export function startStalenessChecker(): void {
  if (intervalHandle) return;

  const intervalMs = config.STALENESS_CHECK_INTERVAL_MS;

  intervalHandle = setInterval(() => {
    runStalenessCheck().catch((err) => {
      logger.error({ err }, 'Staleness check sweep failed');
    });
  }, intervalMs);

  logger.info({ intervalMs }, 'Staleness checker started');
}

export function stopStalenessChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Staleness checker stopped');
  }
}

async function runStalenessCheck(): Promise<void> {
  if (running) {
    logger.debug('Staleness check already running, skipping');
    return;
  }
  running = true;

  try {
    const links = await db.select().from(workspaceLinks);

    for (const link of links) {
      const channelId = link.internalChannelId || config.DISCORD_CHANNEL_ID;
      await checkOrgProposals(link.orgId, channelId);
      await checkOrgSuggestions(link.orgId, channelId);
    }
  } catch (err) {
    logger.error({ err }, 'Staleness check failed');
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Agent proposals (pendingActions table)
// ---------------------------------------------------------------------------

async function checkOrgProposals(orgId: string, channelId: string | null | undefined): Promise<void> {
  const checkThreshold = new Date(Date.now() - config.STALENESS_CHECK_INTERVAL_MS);

  // Find open proposals that haven't been checked recently
  const proposals = await db
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        or(eq(pendingActions.status, 'pending'), eq(pendingActions.status, 'nexus_review')),
        or(
          isNull(pendingActions.lastStalenessCheckAt),
          lte(pendingActions.lastStalenessCheckAt, checkThreshold),
        ),
      ),
    )
    .limit(50);

  if (proposals.length === 0) return;

  logger.info({ orgId, count: proposals.length }, 'Checking proposals for staleness');

  // Collect unique repos to update snapshots
  const repoKeys = new Set<string>();
  for (const p of proposals) {
    const fc = p.fileContext as FileContext | null;
    if (fc?.repoKey) repoKeys.add(fc.repoKey);
  }

  // Update repo snapshots (batch, best-effort)
  for (const repoKey of repoKeys) {
    await updateRepoSnapshot(orgId, repoKey);
  }

  for (const proposal of proposals) {
    try {
      await checkProposal(orgId, proposal, channelId);
    } catch (err) {
      logger.warn({ err, proposalId: proposal.id }, 'Failed to check proposal staleness');
    }
  }
}

async function checkProposal(
  orgId: string,
  proposal: typeof pendingActions.$inferSelect,
  channelId: string | null | undefined,
): Promise<void> {
  const fileContext = proposal.fileContext as FileContext | null;

  // 1. Git-based check (if file context available)
  if (fileContext && fileContext.filePaths.length > 0) {
    const gitResult = await checkGitStaleness(orgId, fileContext, proposal.createdAt);

    if (gitResult === 'changed') {
      // Related files changed — send back for re-review
      await db
        .update(pendingActions)
        .set({
          status: 'nexus_review',
          lastStalenessCheckAt: new Date(),
        })
        .where(eq(pendingActions.id, proposal.id));

      logger.info({ proposalId: proposal.id }, 'Proposal marked stale (git changes detected)');

      if (channelId) {
        const args = proposal.args as Record<string, unknown>;
        await sendAgentMessage(
          channelId,
          'System',
          `Proposal "${args.title ?? proposal.description}" from ${proposal.agentId} was flagged for re-review — related files have changed since it was created.`,
          proposal.orgId,
        ).catch((err) => logger.warn({ err }, 'Failed to send staleness notification'));
      }
      return;
    }
  }

  // 2. TTL-based check
  const repoKey = fileContext?.repoKey;
  const commitFrequency = repoKey ? await getRepoCommitFrequency(orgId, repoKey) : null;
  const ttlDays = getAdaptiveTtlDays(commitFrequency);
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const proposalAge = Date.now() - proposal.createdAt.getTime();

  if (proposalAge < ttlMs) {
    // Not yet past TTL — just update check timestamp
    await db
      .update(pendingActions)
      .set({ lastStalenessCheckAt: new Date() })
      .where(eq(pendingActions.id, proposal.id));
    return;
  }

  // TTL expired — check revalidation count
  if (proposal.stalenessCount >= config.STALENESS_MAX_REVALIDATIONS) {
    // Max revalidations reached — auto-withdraw
    const updatedArgs = {
      ...((proposal.args as any) || {}),
      withdrawReason: `Auto-withdrawn after ${config.STALENESS_MAX_REVALIDATIONS} revalidation cycles`,
    };
    await db
      .update(pendingActions)
      .set({
        status: 'rejected',
        args: updatedArgs,
        resolvedAt: new Date(),
        lastStalenessCheckAt: new Date(),
      })
      .where(eq(pendingActions.id, proposal.id));

    logger.info({ proposalId: proposal.id, stalenessCount: proposal.stalenessCount }, 'Proposal auto-withdrawn (max revalidations)');
    return;
  }

  // Ask originating agent to revalidate
  if (!channelId) {
    await db
      .update(pendingActions)
      .set({ lastStalenessCheckAt: new Date() })
      .where(eq(pendingActions.id, proposal.id));
    return;
  }

  const daysSinceCreated = Math.floor(proposalAge / (24 * 60 * 60 * 1000));
  const revalidationPrompt = `You previously proposed the following action:
---
${proposal.description}
---
This proposal was created ${daysSinceCreated} days ago. The codebase may have changed since then.

Please review whether this proposal is still relevant and valuable.
- If still valid, respond with: <revalidate-proposal id="${proposal.id}">
- If no longer relevant, respond with: <withdraw-proposal id="${proposal.id}">Brief reason why</withdraw-proposal>`;

  try {
    await executeAgent({
      orgId,
      agentId: proposal.agentId as AgentId,
      channelId,
      userId: 'system',
      userName: 'Staleness Checker',
      userMessage: revalidationPrompt,
      needsCodeAccess: false,
      source: 'idle',
    });

    // Update check timestamp (the agent response XML handler will handle revalidation/withdrawal)
    await db
      .update(pendingActions)
      .set({ lastStalenessCheckAt: new Date() })
      .where(eq(pendingActions.id, proposal.id));

    logger.info({ proposalId: proposal.id, agentId: proposal.agentId, daysSinceCreated }, 'Revalidation prompt sent to agent');
  } catch (err) {
    logger.warn({ err, proposalId: proposal.id }, 'Failed to send revalidation prompt');
    // Leave proposal as-is, retry next cycle
    await db
      .update(pendingActions)
      .set({ lastStalenessCheckAt: new Date() })
      .where(eq(pendingActions.id, proposal.id));
  }
}

// ---------------------------------------------------------------------------
// Remote API suggestions (not in pendingActions)
// ---------------------------------------------------------------------------

async function checkOrgSuggestions(orgId: string, channelId: string | null | undefined): Promise<void> {
  // Collect suggestion IDs already linked to pendingActions so we skip them
  const linkedActions = await db
    .select({ suggestionId: pendingActions.suggestionId })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        // Only care about non-null suggestionIds
      ),
    );
  const linkedSuggestionIds = new Set(
    linkedActions.map((a) => a.suggestionId).filter(Boolean) as string[],
  );

  // Iterate over all projects and fetch their pending suggestions
  const projects = await getProjectRegistry().listProjects(orgId);
  if (projects.length === 0) return;

  for (const project of projects) {
    try {
      const suggestions = await getTicketTracker().listSuggestions(orgId, project.id, { status: 'pending' });
      if (suggestions.length === 0) continue;

      // Filter out suggestions that are already tracked as pendingActions
      const unlinked = suggestions.filter((s) => !linkedSuggestionIds.has(s.id));
      if (unlinked.length === 0) continue;

      logger.info(
        { orgId, projectId: project.id, total: suggestions.length, unlinked: unlinked.length },
        'Checking API suggestions for staleness',
      );

      // Update repo snapshots for repos referenced by these suggestions
      const repoKeys = new Set(unlinked.map((s) => s.repoKey));
      for (const repoKey of repoKeys) {
        await updateRepoSnapshot(orgId, repoKey);
      }

      for (const suggestion of unlinked) {
        try {
          await checkSuggestion(orgId, project.id, suggestion, channelId);
        } catch (err) {
          logger.warn({ err, suggestionId: suggestion.id }, 'Failed to check suggestion staleness');
        }
      }
    } catch (err) {
      logger.warn({ err, projectId: project.id }, 'Failed to check suggestions for project');
    }
  }
}

async function checkSuggestion(
  orgId: string,
  projectId: string,
  suggestion: Suggestion,
  channelId: string | null | undefined,
): Promise<void> {
  const createdAt = new Date(suggestion.createdAt);
  const affectedFiles = suggestion.affectedFiles ?? [];

  // 1. Git-based check using affectedFiles
  if (affectedFiles.length > 0) {
    const fileContext: FileContext = {
      repoKey: suggestion.repoKey,
      filePaths: affectedFiles,
    };
    const gitResult = await checkGitStaleness(orgId, fileContext, createdAt);

    if (gitResult === 'changed') {
      // Related files changed — dismiss the stale suggestion
      const result = await getTicketTracker().dismissSuggestion(orgId, projectId, suggestion.id);
      if (result.success) {
        logger.info({ suggestionId: suggestion.id, title: suggestion.title }, 'Suggestion dismissed (git changes detected in affected files)');

        if (channelId) {
          await sendAgentMessage(
            channelId,
            'System',
            `Suggestion "${suggestion.title}" was auto-dismissed — affected files have changed since it was created.`,
            orgId,
          ).catch((err) => logger.warn({ err }, 'Failed to send suggestion staleness notification'));
        }
      }
      return;
    }
  }

  // 2. TTL-based check
  const commitFrequency = await getRepoCommitFrequency(orgId, suggestion.repoKey);
  const ttlDays = getAdaptiveTtlDays(commitFrequency);
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const suggestionAge = Date.now() - createdAt.getTime();

  if (suggestionAge >= ttlMs) {
    // TTL expired — dismiss the stale suggestion
    const result = await getTicketTracker().dismissSuggestion(orgId, projectId, suggestion.id);
    if (result.success) {
      const daysSinceCreated = Math.floor(suggestionAge / (24 * 60 * 60 * 1000));
      logger.info(
        { suggestionId: suggestion.id, title: suggestion.title, daysSinceCreated, ttlDays },
        'Suggestion dismissed (TTL expired)',
      );

      if (channelId) {
        await sendAgentMessage(
          channelId,
          'System',
          `Suggestion "${suggestion.title}" was auto-dismissed — it has been pending for ${daysSinceCreated} days (TTL: ${ttlDays} days).`,
          orgId,
        ).catch((err) => logger.warn({ err }, 'Failed to send suggestion TTL notification'));
      }
    }
  }
}
