import { getLastHumanActivityTimestamp, getLastIdleTimestamp, logActivity } from './activity.js';
import { computeThrottleLevel, shouldCreateNewWork } from './throttle.js';
import { executeAgent } from '../agents/executor.js';
import { getAgent } from '../agents/registry.js';
import { sendAgentMessage } from '../bot/formatter.js';
import { sendApprovalMessage } from '../bot/interactions.js';
import { storeMessage } from '../conversation/service.js';
import { queueSuggestion } from './service.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { isAutonomousMode } from '../settings/service.js';
import { AGENT_IDS, type AgentId } from '../agents/types.js';
import { db } from '../db/index.js';
import { workspaceLinks, pendingActions } from '../db/schema.js';
import { eq, and, gte } from 'drizzle-orm';
import {
  BACKOFF_DELAYS_MS,
  getBackoffStep,
  incrementBackoffStep,
  resetBackoffStep,
  getIdleInvocations24h,
  getEffectiveDailyBudget,
} from './backoff.js';
import { allocateNextProject } from './allocator.js';


const CHECK_INTERVAL_MS = 60_000; // Check every 60 seconds
const QUEUE_THRESHOLD_MS = 3_600_000; // 1 hour
const IDLE_ELIGIBLE_AGENTS = AGENT_IDS.filter(id => id !== 'nexus');
let roundRobinIndex = 0;
let timerHandle: ReturnType<typeof setInterval> | null = null;
let idleRunning = false;

function getNextAgent(): AgentId {
  const agentId = IDLE_ELIGIBLE_AGENTS[roundRobinIndex % IDLE_ELIGIBLE_AGENTS.length];
  roundRobinIndex++;
  return agentId;
}

const IDLE_PROMPT_BASE = `The team has been idle. Identify the single highest priority item to address next (bug fix, improvement, or new feature).

CRITICAL: You MUST include a <ticket-proposal> block in your response. This is the ONLY way to create work items. Without it, your response has no effect.

Your response MUST contain exactly this format:

<ticket-proposal>
{"kind":"bug","title":"Short title","description":"Detailed description","project":"Exact Project Name"}
</ticket-proposal>

Brief explanation of why this matters.

Do NOT narrate your investigation. Go straight to the proposal.`;

async function buildIdlePrompt(orgId: string, targetProjectId?: string, targetProjectName?: string): Promise<string> {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const proposals = await db
      .select({ args: pendingActions.args })
      .from(pendingActions)
      .where(
        and(
          eq(pendingActions.orgId, orgId),
          eq(pendingActions.command, 'create-ticket'),
          gte(pendingActions.createdAt, sevenDaysAgo),
        ),
      );

    if (proposals.length === 0) {
      let base = IDLE_PROMPT_BASE;
      if (targetProjectName) {
        base += `\n\nYou MUST propose a ticket for the **${targetProjectName}** project. Do not propose for other projects.`;
      }
      return base;
    }

    const counts = new Map<string, number>();
    for (const p of proposals) {
      const args = p.args as Record<string, unknown>;
      const project = (args.project as string) || (args['project-id'] as string) || 'unknown';
      counts.set(project, (counts.get(project) ?? 0) + 1);
    }

    const lines = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `- ${name}: ${count} proposal${count !== 1 ? 's' : ''}`);

    let prompt = `${IDLE_PROMPT_BASE}\n\nRecent proposal distribution (last 7 days):\n${lines.join('\n')}\nConsider targeting projects with fewer recent proposals.`;

    if (targetProjectName) {
      prompt += `\n\nYou MUST propose a ticket for the **${targetProjectName}** project. Do not propose for other projects.`;
    }

    return prompt;
  } catch (err) {
    logger.warn({ err }, 'Failed to build idle prompt distribution');
    let base = IDLE_PROMPT_BASE;
    if (targetProjectName) {
      base += `\n\nYou MUST propose a ticket for the **${targetProjectName}** project. Do not propose for other projects.`;
    }
    return base;
  }
}

const IDLE_REVIEW_PROMPT =
  'The team has been idle, but there are already many pending suggestions awaiting review. Instead of proposing new work, review the existing pending suggestions. Investigate the codebase and recent changes to determine if any pending suggestions are now outdated, redundant, or should be refined. If you find a suggestion that is no longer relevant due to code changes, use the withdraw-proposal command. If a suggestion could be improved or made more specific, note your findings. Do NOT propose new tickets — focus on quality over quantity. Your Discord message should summarize what you reviewed and any actions taken.';

/** Core idle prompt logic shared by timer and manual trigger */
async function runIdlePrompt(orgId: string, channelId: string, forceAgentId?: AgentId, shouldQueue = false, reviewOnly = false, projectId?: string, projectName?: string): Promise<AgentId> {
  const agentId = forceAgentId ?? getNextAgent();
  const agent = getAgent(agentId);
  if (!agent) {
    logger.warn({ agentId }, 'Idle prompt: agent not found in registry');
    return agentId;
  }

  const prompt = reviewOnly ? IDLE_REVIEW_PROMPT : await buildIdlePrompt(orgId, projectId, projectName);

  logger.info(
    { orgId, agentId, shouldQueue, reviewOnly, forced: !!forceAgentId },
    'Running idle prompt for agent',
  );

  const autonomous = await isAutonomousMode(orgId);

  const response = await executeAgent({
    orgId,
    agentId,
    channelId,
    userId: 'system',
    userName: 'System (Idle Timer)',
    userMessage: prompt,
    needsCodeAccess: false,
    source: 'idle',
    onActionQueued: async (actionId, description) => {
      if (!autonomous) {
        await sendApprovalMessage(channelId, agent.title, actionId, description);
      }
    },
  });

  logger.info(
    { orgId, agentId, hasResponse: !!response, responseLength: response?.length ?? 0 },
    'Idle prompt execution completed',
  );

  if (response) {
    if (shouldQueue) {
      await queueSuggestion({
        orgId,
        agentId,
        content: response,
        status: 'queued',
      });
    } else {
      await sendAgentMessage(channelId, agent.title, response, orgId);

      await storeMessage({
        orgId,
        channelId,
        discordMessageId: `idle-${Date.now()}`,
        authorId: 'agent',
        authorName: agent.title,
        content: response,
        isAgent: true,
        agentId,
      });
    }
  }

  await logActivity(shouldQueue ? 'idle_queued' : 'idle_prompt', agentId, channelId, orgId,
    projectId ? { projectId, projectName } : undefined,
  );
  return agentId;
}

async function checkIdle(): Promise<void> {
  if (idleRunning) return;
  idleRunning = true;

  try {
    const links = await db.select().from(workspaceLinks);
    for (const link of links) {
      const orgId = link.orgId;
      const channelId = link.internalChannelId || config.DISCORD_CHANNEL_ID;
      if (!channelId) continue;

      const now = Date.now();

      // Use human-activity timestamp so idle-triggered activity doesn't reset the clock
      const lastHumanActivity = await getLastHumanActivityTimestamp(orgId);
      const elapsedSinceHuman = lastHumanActivity ? now - lastHumanActivity.getTime() : Infinity;

      if (elapsedSinceHuman < config.IDLE_TIMEOUT_MS) continue;

      // Determine the last idle invocation for backoff
      const lastIdleTs = await getLastIdleTimestamp(orgId);

      // If a human came back after the last idle trigger, reset backoff
      if (lastHumanActivity && (!lastIdleTs || lastHumanActivity > lastIdleTs)) {
        await resetBackoffStep(orgId);
      }

      const autonomous = await isAutonomousMode(orgId);
      const backoffStep = await getBackoffStep(orgId);

      const elapsedSinceIdle = lastIdleTs ? now - lastIdleTs.getTime() : Infinity;

      if (autonomous) {
        // Autonomous mode: skip exponential backoff but enforce IDLE_TIMEOUT_MS spacing
        if (elapsedSinceIdle < config.IDLE_TIMEOUT_MS) continue;
      } else {
        // Non-autonomous: exponential backoff spacing
        const requiredDelay = BACKOFF_DELAYS_MS[backoffStep];
        if (elapsedSinceIdle < requiredDelay) continue;
      }

      // Enforce rolling 24h cap (pacing-aware, with plan-tier safety cap)
      const maxIdlePer24h = await getEffectiveDailyBudget(orgId);
      const count24h = await getIdleInvocations24h(orgId);
      if (count24h >= maxIdlePer24h) {
        logger.warn({ event: 'agent_idle_cap_reached', orgId, count24h, limit: maxIdlePer24h });
        continue;
      }

      const metrics = await computeThrottleLevel(orgId);
      logger.info({ orgId, ...metrics }, 'Idle throttle metrics');

      let reviewOnly: boolean;
      if (metrics.level === 'paused') {
        logger.info({ orgId, reason: metrics.reason }, 'Idle paused, skipping org');
        continue;
      } else if (metrics.level === 'review_only') {
        reviewOnly = true;
      } else if (metrics.level === 'reduced') {
        reviewOnly = !(await shouldCreateNewWork(orgId));
      } else {
        reviewOnly = false;
      }

      // Try project-aware allocation (new system)
      let allocatedProjectId: string | undefined;
      let allocatedProjectName: string | undefined;
      try {
        const allocation = await allocateNextProject(orgId);
        if (allocation) {
          allocatedProjectId = allocation.projectId;
          allocatedProjectName = allocation.projectName;
          logger.info({ orgId, projectId: allocatedProjectId, projectName: allocatedProjectName }, 'Allocated project for idle prompt');
        }
        // allocation === null means either all suppressed or shadow mode — continue with old behavior
      } catch (err) {
        logger.warn({ err, orgId }, 'Project allocation failed, falling back to unscoped idle');
      }

      // In autonomous mode, always send to Discord — don't silently queue
      const shouldQueue = !autonomous && elapsedSinceHuman > QUEUE_THRESHOLD_MS;
      const agentId = await runIdlePrompt(orgId, channelId, undefined, shouldQueue, reviewOnly, allocatedProjectId, allocatedProjectName);

      // Increment backoff after a successful invocation
      await incrementBackoffStep(orgId);

      // Emit structured telemetry
      const nextBackoffStep = Math.min(backoffStep + 1, BACKOFF_DELAYS_MS.length - 1);
      logger.info({
        event: 'agent_idle_tokens_burned',
        orgId,
        agentId,
        backoffStep,
        nextBackoffStep,
        nextDelayMs: BACKOFF_DELAYS_MS[nextBackoffStep],
        dailyInvocationCount: count24h + 1,
      });
    }
  } catch (err) {
    logger.error({ err }, 'Idle check failed');
  } finally {
    idleRunning = false;
  }
}

/**
 * Force-trigger an idle prompt immediately, bypassing the timer check.
 * Optionally specify an agent; otherwise uses round-robin.
 */
export async function triggerIdleNow(orgId: string, channelId: string, forceAgentId?: AgentId): Promise<void> {
  if (idleRunning) {
    logger.warn('Idle prompt already running, skipping forced trigger');
    return;
  }
  idleRunning = true;
  try {
    const metrics = await computeThrottleLevel(orgId);
    logger.info({ orgId, ...metrics }, 'Forced idle throttle metrics');

    if (metrics.level === 'paused') {
      logger.warn({ orgId, reason: metrics.reason }, 'Idle paused, skipping forced trigger');
      return;
    }

    let reviewOnly: boolean;
    if (metrics.level === 'review_only') {
      reviewOnly = true;
    } else if (metrics.level === 'reduced') {
      reviewOnly = !(await shouldCreateNewWork(orgId));
    } else {
      reviewOnly = false;
    }

    const backoffStep = await getBackoffStep(orgId);
    const agentId = await runIdlePrompt(orgId, channelId, forceAgentId, false, reviewOnly);

    // triggerIdleNow skips delay/cap guards but still increments backoff and emits telemetry
    await incrementBackoffStep(orgId);

    const nextBackoffStep = Math.min(backoffStep + 1, BACKOFF_DELAYS_MS.length - 1);
    logger.info({
      event: 'agent_idle_tokens_burned',
      orgId,
      agentId,
      backoffStep,
      nextBackoffStep,
      nextDelayMs: BACKOFF_DELAYS_MS[nextBackoffStep],
      dailyInvocationCount: null, // not computed for forced triggers
    });
  } catch (err) {
    logger.error({ err }, 'Forced idle prompt failed');
  } finally {
    idleRunning = false;
  }
}

export function startIdleTimer(): void {
  if (timerHandle) return;
  timerHandle = setInterval(checkIdle, CHECK_INTERVAL_MS);
  logger.info(
    { checkIntervalMs: CHECK_INTERVAL_MS, idleTimeoutMs: config.IDLE_TIMEOUT_MS },
    'Idle timer started',
  );
}

export function stopIdleTimer(): void {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
    logger.info('Idle timer stopped');
  }
}
