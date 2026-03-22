import { executeAgent } from '../agents/executor.js';
import { getAgent } from '../agents/registry.js';
import { sendAgentMessage } from '../bot/formatter.js';
import { sendApprovalMessage, sendAutonomousNotification, sendPublicChannelAlerts } from '../bot/interactions.js';
import { storeMessage } from '../conversation/service.js';
import { logActivity } from '../idle/activity.js';
import { db } from '../db/index.js';
import { pendingActions, workspaceLinks } from '../db/schema.js';
import { eq, and, lte } from 'drizzle-orm';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logCircuitBreakerTripped } from '../telemetry/cross-agent.js';
import type { AgentId } from '../agents/types.js';
import {
  resolveAutonomousMode,
  isNexusReportsEnabled
} from '../settings/service.js';
import { getTicketTracker } from '../adapters/registry.js';
import { parseArgs } from '../utils/parse-args.js';
import { shouldCreateSuggestion } from '../idle/throttle.js';

let sweepHandle: NodeJS.Timeout | null = null;
const nexusDebounceMap = new Map<string, NodeJS.Timeout>();

/**
 * Main Nexus loop: reviews proposals and identifies stalled work.
 */
async function runSweep(): Promise<void> {
  try {
    const links = await db.select().from(workspaceLinks).limit(100);
    for (const link of links) {
      await runNexusReviewCycle(link.orgId, link.internalChannelId || config.DISCORD_CHANNEL_ID!);
    }
  } catch (err) {
    logger.error({ err }, 'Nexus sweep failed');
  }
}

export async function startNexusScheduler(): Promise<void> {
  const reviewInterval = config.CTO_REVIEW_INTERVAL_MS;

  // Run initial sweep shortly after startup (30s delay to let other systems initialize)
  setTimeout(() => {
    runSweep().catch((err) => logger.error({ err }, 'Initial Nexus sweep failed'));
  }, 30_000);

  sweepHandle = setInterval(runSweep, reviewInterval);

  logger.info({ reviewIntervalMs: reviewInterval, debounceMs: config.CTO_DEBOUNCE_MS }, 'Nexus scheduler started');
}

export function onProposalCreated(orgId: string): void {
  const existing = nexusDebounceMap.get(orgId);
  if (existing) {
    logger.debug({ orgId }, 'Nexus debounce reset for org');
    clearTimeout(existing);
  }

  logger.info({ orgId, debounceMs: config.CTO_DEBOUNCE_MS }, 'Nexus review debounce scheduled');

  nexusDebounceMap.set(orgId, setTimeout(() => {
    nexusDebounceMap.delete(orgId);

    (async () => {
      const [link] = await db.select().from(workspaceLinks).where(eq(workspaceLinks.orgId, orgId)).limit(1);
      const channelId = link?.internalChannelId || config.DISCORD_CHANNEL_ID;

      if (channelId) {
        await runNexusReviewCycle(orgId, channelId);
      } else {
        logger.warn({ orgId }, 'Nexus debounce fired but no channelId found');
      }
    })().catch((err) => {
      logger.error({ err, orgId }, 'Nexus debounce callback failed');
    });
  }, config.CTO_DEBOUNCE_MS));
}

/**
 * Escalate a proposal that Nexus failed to process within the TTL.
 * Ask the original agent to self-evaluate; if that also fails to produce
 * a structured decision, auto-approve in autonomous mode (the agent already
 * vetted the proposal) or auto-reject in non-autonomous mode.
 */
async function escalateStuckProposal(
  proposal: typeof pendingActions.$inferSelect,
  orgId: string,
  channelId: string,
): Promise<void> {
  const agentId = proposal.agentId as AgentId;
  const args = parseArgs(proposal.args);

  logger.warn(
    { orgId, proposalId: proposal.id, agentId, description: proposal.description },
    'Proposal stuck in nexus_review — escalating to original agent',
  );

  // Ask the original agent to self-evaluate
  const selfEvalPrompt = `Your ticket proposal has been stuck in the Nexus review queue for over 12 hours because Nexus was unable to render a decision. Please re-evaluate your own proposal and decide whether it should proceed or be withdrawn.

Proposal ID: \`${proposal.id}\`
Title: "${args.title}"
Description: "${args.description}"
Project: ${args.project ?? 'unknown'}

If you still believe this proposal is valid, approve it:
<approve-proposal>{"id": "${proposal.id}", "reason": "Self-approved: <your rationale>"}</approve-proposal>

If the proposal is no longer relevant or should be dropped:
<reject-proposal>{"id": "${proposal.id}", "reason": "<your rationale>"}</reject-proposal>

You MUST include exactly one of the above blocks.`;

  try {
    await executeAgent({
      orgId,
      agentId,
      channelId,
      userId: 'system',
      userName: 'System (Stuck Proposal Escalation)',
      userMessage: selfEvalPrompt,
      needsCodeAccess: false,
      source: 'idle',
    });

    // Check if the agent resolved it
    const [updated] = await db
      .select({ status: pendingActions.status })
      .from(pendingActions)
      .where(eq(pendingActions.id, proposal.id))
      .limit(1);

    if (updated && updated.status !== 'nexus_review') {
      logger.info({ proposalId: proposal.id, newStatus: updated.status }, 'Stuck proposal resolved by original agent');
      return;
    }
  } catch (err) {
    logger.error({ err, proposalId: proposal.id }, 'Failed to escalate stuck proposal to original agent');
  }

  // Agent also failed to produce a structured decision — force-resolve
  const autonomous = await resolveAutonomousMode({ orgId, channelId: proposal.channelId, repoKey: args['repo-key'] as string | undefined });
  if (autonomous) {
    // In autonomous mode, trust the original agent's judgement — create ticket directly
    logger.warn({ proposalId: proposal.id }, 'Force-approving stuck proposal (autonomous mode)');
    try {
      await db.update(pendingActions)
        .set({ status: 'approved', resolvedAt: new Date() })
        .where(eq(pendingActions.id, proposal.id));

      const ticketResult = await getTicketTracker().createTicket({
        orgId,
        kind: (args.kind as 'bug' | 'feature' | 'task') ?? 'task',
        title: args.title as string,
        description: args.description as string,
        repoKey: args['repo-key'] as string,
        projectId: args['project-id'] as string,
        priority: args.priority ? parseInt(args.priority as string, 10) : undefined,
        createdByAgentId: agentId,
      });

      if (ticketResult.success) {
        logger.info({ proposalId: proposal.id, ticketId: ticketResult.ticketId }, 'Stuck proposal force-approved — ticket created');
        await sendAutonomousNotification(channelId, getAgent(agentId)?.title ?? agentId, proposal.id, ticketResult);
      } else {
        logger.error({ proposalId: proposal.id, error: ticketResult.error }, 'Stuck proposal force-approved but ticket creation failed');
      }
    } catch (err) {
      logger.error({ err, proposalId: proposal.id }, 'Error during force-approve ticket creation');
    }
  } else {
    // In non-autonomous mode, reject to be safe — humans can re-propose if needed
    logger.warn({ proposalId: proposal.id }, 'Force-rejecting stuck proposal (non-autonomous mode)');
    await db.update(pendingActions)
      .set({ status: 'rejected', resolvedAt: new Date() })
      .where(eq(pendingActions.id, proposal.id));
  }
}

/**
 * Stuck proposal TTL: after 12 hours in nexus_review (3+ sweep cycles),
 * escalate to the original agent for self-evaluation instead of letting
 * it rot and tank the velocity score.
 */
const NEXUS_STUCK_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Maximum number of Nexus ↔ agent review iterations before the circuit
 * breaker trips and the ticket is escalated to human review.
 */
const MAX_REVIEW_CYCLES = 3;

async function runNexusReviewCycle(orgId: string, channelId: string): Promise<void> {
  logger.info({ orgId }, 'Starting Nexus review cycle');

  try {
    const agent = getAgent('nexus');
    if (!agent) return;

    // Escalate proposals stuck in nexus_review for over 12 hours.
    // Nexus failed to produce a structured decision after multiple sweep
    // cycles, so we send the proposal back to the original agent for
    // self-evaluation.  In autonomous mode, if that also fails, we
    // auto-approve — the proposing agent already vetted it.
    const staleThreshold = new Date(Date.now() - NEXUS_STUCK_TTL_MS);
    const stuckProposals = await db
      .select()
      .from(pendingActions)
      .where(and(
        eq(pendingActions.orgId, orgId),
        eq(pendingActions.status, 'nexus_review'),
        lte(pendingActions.createdAt, staleThreshold),
      ));

    for (const stuck of stuckProposals) {
      await escalateStuckProposal(stuck, orgId, channelId);
    }

    const proposals = await db
      .select()
      .from(pendingActions)
      .where(and(eq(pendingActions.orgId, orgId), eq(pendingActions.status, 'nexus_review')))
      .orderBy(pendingActions.createdAt)
      .limit(20);

    logger.info({ orgId, count: proposals.length }, 'Nexus review: proposals in queue');
    if (proposals.length === 0) return;

    const decisions: string[] = [];

    for (const proposal of proposals) {
      const args = parseArgs(proposal.args);
      const prompt = `Evaluate proposal ID \`${proposal.id}\` from agent ${proposal.agentId}:
"${proposal.description}"

Args: ${JSON.stringify(proposal.args)}

You MUST render a decision using exactly one of these blocks:

<approve-proposal>{"id": "${proposal.id}", "reason": "your rationale"}</approve-proposal>

OR

<reject-proposal>{"id": "${proposal.id}", "reason": "your rationale"}</reject-proposal>

OR — if the proposal is incomplete, unclear, or missing required information (evidence, acceptance criteria, rollback plan, etc.) and you need the proposing agent to improve it before you can decide:

<defer-proposal>{"id": "${proposal.id}", "reason": "what is missing or needs improvement", "feedback": "specific actionable feedback for the proposing agent"}</defer-proposal>

Do NOT respond conversationally. Output exactly one decision block above and a brief summary.`;

      try {
        const autonomous = await resolveAutonomousMode({ orgId, channelId: proposal.channelId, repoKey: args['repo-key'] as string | undefined });

        const response = await executeAgent({
          orgId,
          agentId: 'nexus',
          channelId,
          userId: 'system',
          userName: 'Nexus Scheduler',
          userMessage: prompt,
          needsCodeAccess: false,
          source: 'idle',
          onActionQueued: async (actionId, description) => {
            if (!autonomous) {
              await sendApprovalMessage(channelId, agent.title, actionId, description);
            }
          },
        });

        if (response) {
          const [updated] = await db
            .select({ status: pendingActions.status, args: pendingActions.args, suggestionId: pendingActions.suggestionId })
            .from(pendingActions)
            .where(eq(pendingActions.id, proposal.id))
            .limit(1);

          let decision = updated?.status === 'nexus_review'
            ? 'deferred'
            : updated?.status === 'pending'
              ? 'approved — pending human review'
              : updated?.status ?? 'unknown';
          const parsedUpdatedArgs = parseArgs(updated?.args);
          let reason = parsedUpdatedArgs.ctoDecisionReason
            ?? parsedUpdatedArgs.ctoRejectionReason
            ?? parsedUpdatedArgs.ctoDeferralReason
            ?? null;

          // Fallback: if no structured reason was recorded but we have a response,
          // use a trimmed excerpt of the raw LLM response as the reason
          if (!reason && decision === 'deferred' && response.trim()) {
            const excerpt = response.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim().slice(0, 200);
            reason = excerpt || 'no reason recorded';
            // Persist the fallback reason so it's available for future reference
            const fallbackArgs: Record<string, unknown> = { ...parsedUpdatedArgs, ctoDeferralReason: reason };
            await db.update(pendingActions)
              .set({ args: fallbackArgs })
              .where(eq(pendingActions.id, proposal.id));
            logger.warn({ proposalId: proposal.id, excerpt }, 'No structured decision block found — using raw response as deferral reason');
          }
          reason = reason ?? 'no reason recorded';

          // When deferred, send feedback to the original agent so it can revise
          if (decision === 'deferred' && parsedUpdatedArgs.ctoDeferralFeedback) {
            const feedback = parsedUpdatedArgs.ctoDeferralFeedback as string;
            const previousDescription = (args.description as string) ?? proposal.description;
            const currentCycleCount = typeof parsedUpdatedArgs.reviewCycleCount === 'number'
              ? parsedUpdatedArgs.reviewCycleCount
              : 0;
            const nextCycleCount = currentCycleCount + 1;

            if (nextCycleCount >= MAX_REVIEW_CYCLES) {
              // Circuit breaker tripped — too many review cycles without resolution.
              // Escalate to human review instead of dispatching another revision.
              logCircuitBreakerTripped({
                orgId,
                proposalId: proposal.id,
                agentId: proposal.agentId,
                cycleCount: nextCycleCount,
                maxCycles: MAX_REVIEW_CYCLES,
              });

              await db.update(pendingActions)
                .set({ status: 'waiting_for_human', resolvedAt: new Date() })
                .where(eq(pendingActions.id, proposal.id));

              decision = `circuit breaker tripped — escalated to human (${nextCycleCount} cycles)`;
              logger.warn(
                { proposalId: proposal.id, agentId: proposal.agentId, cycleCount: nextCycleCount },
                'Review circuit breaker tripped: proposal escalated to waiting_for_human',
              );
            } else {
              // Persist the incremented cycle count before dispatching the revision
              await db.update(pendingActions)
                .set({ args: { ...parsedUpdatedArgs, reviewCycleCount: nextCycleCount } })
                .where(eq(pendingActions.id, proposal.id));

              // Reject the old proposal so it doesn't get re-evaluated in a loop
              await db.update(pendingActions)
                .set({ status: 'rejected', resolvedAt: new Date() })
                .where(eq(pendingActions.id, proposal.id));

              // Dispatch the original agent with steering to revise
              executeAgent({
                orgId,
                agentId: proposal.agentId as AgentId,
                channelId,
                userId: 'system',
                userName: 'Nexus (Revision Request)',
                userMessage: 'Revise your proposal based on Nexus feedback.',
                needsCodeAccess: false,
                source: 'idle',
                steering: {
                  originalActionId: proposal.id,
                  previousProposal: previousDescription,
                  userFeedback: feedback,
                },
              }).catch((err) => {
                logger.error({ err, proposalId: proposal.id, agentId: proposal.agentId }, 'Failed to dispatch revision to agent');
              });

              decision = 'deferred — revision requested';
              logger.info(
                { proposalId: proposal.id, agentId: proposal.agentId, cycleCount: nextCycleCount },
                'Deferred proposal: revision dispatched to original agent',
              );
            }
          }

          if (autonomous && updated?.status === 'pending') {
            const updatedArgs = parseArgs(updated.args);
            try {
              await db.update(pendingActions)
                .set({ status: 'approved', resolvedAt: new Date() })
                .where(eq(pendingActions.id, proposal.id));

              const ticketResult = await getTicketTracker().createTicket({
                orgId,
                kind: (updatedArgs.kind as 'bug' | 'feature' | 'task') ?? 'task',
                title: updatedArgs.title as string,
                description: updatedArgs.description as string,
                repoKey: updatedArgs['repo-key'] as string,
                projectId: updatedArgs['project-id'] as string,
                priority: updatedArgs.priority ? parseInt(updatedArgs.priority as string, 10) : undefined,
                createdByAgentId: proposal.agentId as AgentId,
              });

              await sendAutonomousNotification(channelId, agent.title, proposal.id, ticketResult);

              sendPublicChannelAlerts(
                (updatedArgs.kind as string) ?? 'task',
                (updatedArgs.title as string) ?? 'Untitled',
                orgId,
              ).catch((err) => logger.error({ err }, 'Failed to send public channel alerts'));

              decision = ticketResult.success
                ? `auto-approved — ticket ${ticketResult.ticketId}`
                : 'auto-approved — ticket creation failed, retrying';
            } catch (err) {
              logger.error({ err, proposalId: proposal.id }, 'Autonomous ticket creation failed');
              decision = 'auto-approved — ticket creation error';
            }
          } else if (!autonomous && updated?.status === 'pending' && !updated?.suggestionId) {
            // Non-autonomous: create a suggestion in the dashboard for human review
            // (skip if the fast path in executor.ts already created one)
            // Throttle check: skip suggestion creation if backlogged, unless user-initiated
            const canCreate = await shouldCreateSuggestion(orgId, proposal.source);
            if (canCreate) {
              const updatedArgs = parseArgs(updated.args);
              try {
                const suggestionResult = await getTicketTracker().createSuggestion(orgId, {
                  repoKey: updatedArgs['repo-key'] as string,
                  title: updatedArgs.title as string,
                  kind: (updatedArgs.kind as 'bug' | 'feature' | 'task') ?? 'task',
                  description: updatedArgs.description as string,
                  projectId: updatedArgs['project-id'] as string,
                  priority: updatedArgs.priority ? parseInt(updatedArgs.priority as string, 10) : undefined,
                });

                if (suggestionResult.success && suggestionResult.suggestionId) {
                  await db.update(pendingActions)
                    .set({ suggestionId: suggestionResult.suggestionId })
                    .where(eq(pendingActions.id, proposal.id));
                  logger.info({ proposalId: proposal.id, suggestionId: suggestionResult.suggestionId }, 'Suggestion created for non-autonomous proposal');
                } else {
                  logger.error({ proposalId: proposal.id, error: suggestionResult.error }, 'Failed to create suggestion for non-autonomous proposal');
                }
              } catch (err) {
                logger.error({ err, proposalId: proposal.id }, 'Error creating suggestion for non-autonomous proposal');
              }

              // Send Discord approval message with approve/reject buttons
              try {
                const proposingAgent = getAgent(proposal.agentId as AgentId);
                await sendApprovalMessage(channelId, proposingAgent?.title ?? proposal.agentId, proposal.id, proposal.description);
              } catch (err) {
                logger.error({ err, proposalId: proposal.id }, 'Failed to send approval message for non-autonomous proposal');
              }
            } else {
              logger.info({ proposalId: proposal.id, source: proposal.source }, 'Suggestion creation throttled for non-autonomous proposal');
            }
          }

          decisions.push(`- **[${decision.toUpperCase()}]** [${proposal.agentId}] "${args.title}" — ${reason}`);
        }
      } catch (err) {
        logger.error({ err, proposalId: proposal.id }, 'Nexus failed to evaluate proposal');
      }
    }

    if (decisions.length > 0) {
      const summary = `Nexus review cycle complete — ${decisions.length} proposal(s) evaluated:\n\n${decisions.join('\n')}`;
      const reportsEnabled = await isNexusReportsEnabled(orgId);
      if (reportsEnabled) {
        await sendAgentMessage(channelId, agent.title, summary, orgId);
        await storeMessage({
          orgId,
          channelId,
          discordMessageId: `nexus-review-${Date.now()}`,
          authorId: 'agent',
          authorName: agent.title,
          content: summary,
          isAgent: true,
          agentId: 'nexus',
        });
      }
    }

    await logActivity('nexus_review_cycle', 'nexus', channelId, orgId);
  } catch (err) {
    logger.error({ err, orgId }, 'Nexus review cycle failed');
  }
}

export function stopNexusScheduler(): void {
  if (sweepHandle) {
    clearInterval(sweepHandle);
    sweepHandle = null;
  }
  for (const timer of nexusDebounceMap.values()) {
    clearTimeout(timer);
  }
  nexusDebounceMap.clear();
}
