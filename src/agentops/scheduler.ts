/**
 * AgentOps Evaluation Scheduler
 *
 * Runs on a weekly cadence and aggregates human rejections of agent-proposed
 * tickets. Produces a "Top Failure Classes" report and triggers an ADR draft
 * when a specific rejection reason exceeds the configured threshold.
 */

import { db } from '../db/index.js';
import { pendingActions, activityLog, workspaceLinks } from '../db/schema.js';
import { and, eq, gte, desc } from 'drizzle-orm';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logGuardrailEvent } from '../telemetry/index.js';
import { logActivity } from '../idle/activity.js';

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

export function startAgentOpsEvaluationScheduler(): void {
  if (intervalHandle) return;

  intervalHandle = setInterval(() => {
    runEvaluationCheck().catch((err) => {
      logger.error({ err }, 'AgentOps evaluation check failed');
    });
  }, config.AGENTOPS_EVAL_CHECK_INTERVAL_MS);

  logger.info(
    {
      checkIntervalMs: config.AGENTOPS_EVAL_CHECK_INTERVAL_MS,
      evalIntervalMs: config.AGENTOPS_EVAL_INTERVAL_MS,
      windowDays: config.AGENTOPS_EVAL_WINDOW_DAYS,
      adrThreshold: config.AGENTOPS_ADR_REJECTION_THRESHOLD,
    },
    'AgentOps evaluation scheduler started',
  );
}

export function stopAgentOpsEvaluationScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('AgentOps evaluation scheduler stopped');
  }
}

async function runEvaluationCheck(): Promise<void> {
  if (running) {
    logger.debug('AgentOps evaluation already running, skipping');
    return;
  }
  running = true;

  try {
    const links = await db.select().from(workspaceLinks);

    for (const link of links) {
      try {
        await checkOrgEvaluation(link.orgId);
      } catch (err) {
        logger.warn({ err, orgId: link.orgId }, 'AgentOps evaluation failed for org');
      }
    }
  } catch (err) {
    logger.error({ err }, 'AgentOps evaluation check sweep failed');
  } finally {
    running = false;
  }
}

async function checkOrgEvaluation(orgId: string): Promise<void> {
  const [lastRun] = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.orgId, orgId),
        eq(activityLog.kind, 'agentops_evaluation'),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);

  if (lastRun && Date.now() - lastRun.createdAt.getTime() < config.AGENTOPS_EVAL_INTERVAL_MS) {
    logger.debug(
      { orgId, lastRunAt: lastRun.createdAt },
      'AgentOps evaluation skipped — not yet due',
    );
    return;
  }

  await runEvaluation(orgId);
}

async function runEvaluation(orgId: string): Promise<void> {
  const windowStart = new Date(Date.now() - config.AGENTOPS_EVAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Fetch human-rejected proposals in the evaluation window
  const rejectedProposals = await db
    .select({
      id: pendingActions.id,
      agentId: pendingActions.agentId,
      args: pendingActions.args,
      resolvedAt: pendingActions.resolvedAt,
    })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        eq(pendingActions.status, 'rejected'),
        gte(pendingActions.resolvedAt, windowStart),
      ),
    );

  // Only count proposals that were rejected by a human (have humanRejectionReason)
  const humanRejections = rejectedProposals.filter((p) => {
    const args = p.args as Record<string, unknown>;
    return typeof args.humanRejectionReason === 'string';
  });

  if (humanRejections.length === 0) {
    logger.info({ orgId }, 'AgentOps evaluation: no human rejections in window');
    await logActivity('agentops_evaluation', undefined, undefined, orgId, {
      windowDays: config.AGENTOPS_EVAL_WINDOW_DAYS,
      humanRejectionCount: 0,
    });
    return;
  }

  // Aggregate rejection reasons
  const reasonCounts = new Map<string, number>();
  for (const proposal of humanRejections) {
    const args = proposal.args as Record<string, unknown>;
    const reason = (args.humanRejectionReason as string) ?? 'Other';
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  const topFailureClasses = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  logger.info(
    { orgId, windowDays: config.AGENTOPS_EVAL_WINDOW_DAYS, topFailureClasses },
    'AgentOps evaluation: Top Failure Classes report',
  );

  // Emit aggregated telemetry event
  logGuardrailEvent({
    event: 'agentops_evaluation_triggered',
    orgId,
    windowDays: config.AGENTOPS_EVAL_WINDOW_DAYS,
    topFailureClasses,
  });

  // Check if any rejection reason exceeds the ADR draft threshold
  for (const { reason, count } of topFailureClasses) {
    if (count >= config.AGENTOPS_ADR_REJECTION_THRESHOLD) {
      // Find a representative agent for this rejection reason
      const representativeAgent = humanRejections.find((p) => {
        const args = p.args as Record<string, unknown>;
        return args.humanRejectionReason === reason;
      });

      if (representativeAgent) {
        await triggerAdrDraft(orgId, representativeAgent.agentId, reason, count);
      }
    }
  }

  await logActivity('agentops_evaluation', undefined, undefined, orgId, {
    windowDays: config.AGENTOPS_EVAL_WINDOW_DAYS,
    humanRejectionCount: humanRejections.length,
    topFailureClasses,
  });
}

async function triggerAdrDraft(
  orgId: string,
  agentId: string,
  reason: string,
  rejectionCount: number,
): Promise<void> {
  logger.warn(
    { orgId, agentId, reason, rejectionCount, threshold: config.AGENTOPS_ADR_REJECTION_THRESHOLD },
    'AgentOps evaluation: ADR draft triggered — rejection threshold exceeded',
  );

  logGuardrailEvent({
    event: 'agentops_adr_draft_triggered',
    orgId,
    agentId,
    reason,
    rejectionCount,
  });

  // Log to activity log so the ADR draft request is visible and actionable
  await logActivity('agentops_adr_draft', undefined, undefined, orgId, {
    agentId,
    reason,
    rejectionCount,
    threshold: config.AGENTOPS_ADR_REJECTION_THRESHOLD,
    windowDays: config.AGENTOPS_EVAL_WINDOW_DAYS,
    suggestion:
      `Agent proposals with reason "${reason}" have been rejected ${rejectionCount} times ` +
      `in the last ${config.AGENTOPS_EVAL_WINDOW_DAYS} days. ` +
      `Consider drafting a Project Rule or ADR to prevent future agents from proposing similar work.`,
  });
}
