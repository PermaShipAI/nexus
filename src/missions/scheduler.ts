import { executeAgent } from '../agents/executor.js';
import { sendAgentMessage } from '../bot/formatter.js';
import { storeMessage } from '../conversation/service.js';
import { routeMessage } from '../router/index.js';
import { getAgent } from '../agents/registry.js';
import { logger } from '../logger.js';
import type { AgentId } from '../agents/types.js';
import {
  getActiveMissionsDueForHeartbeat,
  getMissionItems,
  getMissionProjects,
  getMissionById,
  recordHeartbeat,
  updateMissionItem,
  createMission,
} from './service.js';
import { checkMissionCompletion, planMission } from './lifecycle.js';
import type { Mission } from '../db/schema.js';
import { db } from '../db/index.js';
import { tickets } from '../db/schema.js';
import { eq } from 'drizzle-orm';

let heartbeatHandle: NodeJS.Timeout | null = null;
const missionDebounceMap = new Map<string, NodeJS.Timeout>();
const MISSION_DEBOUNCE_MS = 10_000; // 10s debounce after item completion

/**
 * Called when an agent declares a mission item complete or verified.
 * Debounces and triggers an early heartbeat so verification/next-item
 * happens promptly instead of waiting for the next scheduled poll.
 */
export function onMissionItemChanged(missionId: string): void {
  const existing = missionDebounceMap.get(missionId);
  if (existing) clearTimeout(existing);

  logger.info({ missionId, debounceMs: MISSION_DEBOUNCE_MS }, 'Mission item changed — early heartbeat scheduled');

  missionDebounceMap.set(missionId, setTimeout(() => {
    missionDebounceMap.delete(missionId);

    getMissionById(missionId).then(async (mission) => {
      if (mission && mission.status === 'active') {
        await runMissionHeartbeat(mission);
      }
    }).catch((err) => {
      logger.error({ err, missionId }, 'Early mission heartbeat failed');
    });
  }, MISSION_DEBOUNCE_MS));
}

export async function startMissionScheduler(): Promise<void> {
  // Initial check after 45s (let other systems initialize)
  setTimeout(() => {
    checkMissionHeartbeats().catch((err) =>
      logger.error({ err }, 'Initial mission heartbeat check failed'),
    );
  }, 45_000);

  heartbeatHandle = setInterval(() => {
    checkMissionHeartbeats().catch((err) =>
      logger.error({ err }, 'Mission heartbeat check failed'),
    );
  }, 30_000);

  logger.info('Mission scheduler started (30s poll interval)');
}

async function checkMissionHeartbeats(): Promise<void> {
  const dueMissions = await getActiveMissionsDueForHeartbeat();
  if (dueMissions.length === 0) return;

  logger.info({ count: dueMissions.length }, 'Missions due for heartbeat');

  for (const mission of dueMissions) {
    try {
      await runMissionHeartbeat(mission);
    } catch (err) {
      logger.error({ err, missionId: mission.id }, 'Mission heartbeat failed');
    }
  }
}

/** Reconcile mission items with ticket execution results */
async function reconcileItemsWithTickets(
  items: Awaited<ReturnType<typeof getMissionItems>>,
  orgId: string,
): Promise<{ executionContext: string }> {
  // Get all tickets for this org
  const orgTickets = await db.select({
    id: tickets.id,
    title: tickets.title,
    executionStatus: tickets.executionStatus,
    executionBranch: tickets.executionBranch,
    mergeStatus: tickets.mergeStatus,
    executionReview: tickets.executionReview,
  }).from(tickets).where(eq(tickets.orgId, orgId)).limit(50);

  const contextLines: string[] = [];

  for (const item of items) {
    if (item.status === 'verified') continue;

    // Find matching tickets — require at least 50% keyword overlap
    const reconStopWords = new Set(['implement','create','build','add','update','with','from','into','the','and','for']);
    const keywords = item.title.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !reconStopWords.has(w));
    const reconMinMatches = Math.max(2, Math.ceil(keywords.length * 0.5));
    const matching = orgTickets.filter(t => {
      const titleLower = t.title.toLowerCase();
      return keywords.filter(kw => titleLower.includes(kw)).length >= reconMinMatches;
    });

    if (matching.length === 0) continue;

    for (const ticket of matching) {
      const status = ticket.executionStatus;
      const branch = ticket.executionBranch;
      const merged = ticket.mergeStatus;

      // Auto-mark items based on ticket status — but ONLY for pending items.
      // Items that are in_progress were either reopened by verification (meaning
      // the work didn't actually meet criteria) or are being actively worked on.
      // Re-marking them agent_complete creates a verify-reopen infinite loop.
      if ((status === 'review_approved' || merged === 'merged') && item.status === 'pending') {
        await updateMissionItem(item.id, {
          status: 'agent_complete',
          completedByAgentId: 'executor',
          heartbeatCount: 0,
        });
        logger.info({ itemId: item.id, ticketId: ticket.id, itemTitle: item.title }, 'Mission item auto-marked as agent_complete from ticket execution');
      }

      // Build context for the heartbeat prompt
      const reviewSnippet = ticket.executionReview ? ticket.executionReview.slice(0, 200) : '';
      contextLines.push(`- **${item.title}** → Ticket "${ticket.title}" [${status}]${branch ? ` branch: \`${branch}\`` : ''}${merged ? ` (${merged})` : ''}${reviewSnippet ? `\n  Review: ${reviewSnippet}` : ''}`);
    }
  }

  return {
    executionContext: contextLines.length > 0
      ? `\n**Execution History (tickets related to this mission):**\n${contextLines.join('\n')}`
      : '',
  };
}

async function runMissionHeartbeat(mission: Mission): Promise<void> {
  let items = await getMissionItems(mission.id);
  const projects = await getMissionProjects(mission.id);

  // Reconcile: auto-update mission items based on ticket execution results
  const { executionContext } = await reconcileItemsWithTickets(items, mission.orgId);

  // Re-fetch items after reconciliation may have updated statuses
  items = await getMissionItems(mission.id);

  // Find the first non-verified item to focus on, skipping stalled items
  // An item is "stalled" if it's been heartbeated 3+ times with no progress
  const MAX_HEARTBEATS_BEFORE_SKIP = 3;
  const focusItem = items.find(
    (i) => (i.status === 'pending' || i.status === 'in_progress')
      && (i.heartbeatCount ?? 0) < MAX_HEARTBEATS_BEFORE_SKIP,
  );

  // If all in-progress items are stalled, skip this entire heartbeat
  // to avoid infinite loops. Items will unstall when execution completes
  // or when reconciliation updates their status.
  const activeItems = items.filter(i => i.status === 'pending' || i.status === 'in_progress');
  const allStalled = activeItems.length > 0 && activeItems.every(i => (i.heartbeatCount ?? 0) >= MAX_HEARTBEATS_BEFORE_SKIP);
  if (allStalled && activeItems.length > 0) {
    logger.info({ missionId: mission.id, stalledCount: activeItems.length }, 'All active items stalled — asking Nexus to re-plan');

    // Ask Nexus to break stalled items into smaller sub-tasks
    const stalledList = activeItems.map(i => `- "${i.title}" (${i.heartbeatCount ?? 0} attempts, item ID: ${i.id})`).join('\n');
    const replanPrompt = `The following mission items have stalled after multiple attempts with no progress:

${stalledList}

**Mission:** ${mission.title}

These items are too large or complex for agents to complete in a single pass. Please break each stalled item into 2-3 smaller, concrete sub-items that can be tackled independently.

For each stalled item, use this block to replace it with smaller sub-items:
<mission-replace-item>{"itemId": "<original-item-id>", "reason": "Breaking into smaller tasks", "replacements": [{"title": "Sub-task title", "description": "How to verify this is done"}, ...]}</mission-replace-item>

If an item should be removed entirely (duplicate or no longer relevant):
<mission-remove-item>{"itemId": "<item-id>", "reason": "Why it should be removed"}</mission-remove-item>`;

    try {
      const response = await executeAgent({
        orgId: mission.orgId,
        agentId: 'nexus' as AgentId,
        channelId: mission.channelId,
        userId: 'system',
        userName: 'Mission Re-planner',
        userMessage: replanPrompt,
        needsCodeAccess: false,
        source: 'idle',
      });

      if (response) {
        await sendAgentMessage(mission.channelId, 'Nexus', response, mission.orgId);
        await storeMessage({
          orgId: mission.orgId,
          channelId: mission.channelId,
          discordMessageId: `mission-replan-${Date.now()}`,
          authorId: 'agent',
          authorName: 'Nexus',
          content: response,
          isAgent: true,
          agentId: 'nexus',
        });
      }
    } catch (err) {
      logger.error({ err, missionId: mission.id }, 'Mission re-planning failed');
    }

    const nextAt = new Date(Date.now() + mission.heartbeatIntervalMs);
    await recordHeartbeat(mission.id, nextAt);
    return;
  }

  // Check completion (before verification — some items may already be done)
  const completed = await checkMissionCompletion(mission.id, mission.orgId);
  if (completed) {
    await sendAgentMessage(
      mission.channelId,
      'Nexus',
      `Mission **${mission.title}** is complete! All checklist items have been verified.`,
      mission.orgId,
    );

    // Handle recurring missions
    if (mission.cronExpression) {
      await spawnRecurrence(mission);
    }
    return;
  }

  if (focusItem) {
    // Check if there are actively running tickets for this item — if so, skip
    // this heartbeat entirely to avoid burning tokens on "still running" messages
    const keywords = focusItem.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const orgTickets = await db.select({
      executionStatus: tickets.executionStatus,
      title: tickets.title,
    }).from(tickets).where(eq(tickets.orgId, mission.orgId)).limit(50);

    const runStopWords = new Set(['implement','create','build','add','update','with','from','into','the','and','for']);
    const runKeywords = focusItem.title.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !runStopWords.has(w));
    const runMinMatches = Math.max(2, Math.ceil(runKeywords.length * 0.5));
    const hasRunningTicket = orgTickets.some(t => {
      if (t.executionStatus !== 'running') return false;
      const titleLower = t.title.toLowerCase();
      return runKeywords.filter(kw => titleLower.includes(kw)).length >= runMinMatches;
    });

    if (hasRunningTicket) {
      logger.info({ missionId: mission.id, focusItem: focusItem.title }, 'Skipping heartbeat — ticket still executing');
      // Schedule next heartbeat and return without burning tokens
      const nextAt = new Date(Date.now() + mission.heartbeatIntervalMs);
      await recordHeartbeat(mission.id, nextAt);
      return;
    }

    // Route to best agent for this item
    const projectContext = projects.map((p) => p.name).join(', ');
    const checklistSummary = items
      .map((i) => {
        const marker =
          i.status === 'verified' ? '[x]' :
          i.status === 'agent_complete' ? '[?]' :
          i.status === 'in_progress' ? '[~]' : '[ ]';
        return `${marker} ${i.title}`;
      })
      .join('\n');

    const projectName = projects[0]?.name ?? 'Unknown';

    // Check if a ticket already exists for this item
    const allTickets = await db.select({ title: tickets.title, executionStatus: tickets.executionStatus })
      .from(tickets).where(eq(tickets.orgId, mission.orgId)).limit(50);
    // Match items to tickets — require at least 50% of meaningful keywords to match
    // (previous threshold of 2 keywords was too loose, matching unrelated items)
    const stopWords = new Set(['implement','create','build','add','update','with','from','into','the','and','for']);
    const itemKeywords = focusItem.title.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));
    const minMatches = Math.max(2, Math.ceil(itemKeywords.length * 0.5));
    const existingTicket = allTickets.find(t => {
      const tl = t.title.toLowerCase();
      return itemKeywords.filter(kw => tl.includes(kw)).length >= minMatches;
    });

    let heartbeatMessage: string;

    if (existingTicket) {
      // Ticket exists — just check status and report
      heartbeatMessage = `Mission "${mission.title}" — item **${focusItem.title}** has a matching ticket: "${existingTicket.title}" [${existingTicket.executionStatus}].

${existingTicket.executionStatus === 'review_approved' || existingTicket.executionStatus === 'completed' ? `The ticket is done. Declare this item complete:
<mission-item-complete>{"itemId":"${focusItem.id}","summary":"Ticket completed: ${existingTicket.title}"}</mission-item-complete>` :
existingTicket.executionStatus === 'running' ? 'The executor is currently working on this. No action needed — will check again next heartbeat.' :
existingTicket.executionStatus === 'failed' || existingTicket.executionStatus === 'review_failed' ? `The ticket failed. Either retry it or create a new, more focused ticket:
<ticket-proposal>
{"kind":"task","title":"${focusItem.title.slice(0, 80)}","description":"Reattempt with narrower scope. Acceptance criteria: ${focusItem.description.slice(0, 200)}","project":"${projectName}"}
</ticket-proposal>` :
`Ticket is ${existingTicket.executionStatus}. Waiting for it to progress.`}

If this item is a duplicate: <mission-remove-item>{"itemId":"${focusItem.id}","reason":"Why"}</mission-remove-item>`;
    } else {
      // No ticket — CREATE ONE. Short, directive prompt.
      heartbeatMessage = `Create a ticket for: "${focusItem.title}"

Project: ${projectName}
Criteria: ${focusItem.description}

Output ONLY this block with a detailed description:

<ticket-proposal>
{"kind":"task","title":"${focusItem.title.slice(0, 80)}","description":"WRITE DETAILED ACCEPTANCE CRITERIA HERE","project":"${projectName}"}
</ticket-proposal>`;
    }

    // Mark as in_progress and increment heartbeat count
    await updateMissionItem(focusItem.id, {
      status: focusItem.status === 'pending' ? 'in_progress' : undefined,
      heartbeatCount: (focusItem.heartbeatCount ?? 0) + 1,
    });

    // Pick the agent: for ticket creation, use an implementation agent (not Nexus).
    // Nexus governs but won't create tickets — it reasons about dependencies instead.
    // For items with existing tickets, route normally for status checks.
    let agentId: AgentId;
    if (!existingTicket) {
      // No ticket — send to an implementation agent who will actually create one
      const implAgents: AgentId[] = ['sre', 'product-manager', 'release-engineering', 'ux-designer'];
      agentId = focusItem.assignedAgentId as AgentId ?? implAgents[Math.floor(Math.random() * implAgents.length)];
      if (agentId === 'nexus') agentId = implAgents[0]; // Never send ticket creation to Nexus
    } else {
      // Existing ticket — route normally
      const routes = await routeMessage(heartbeatMessage, mission.channelId, 'Nexus', mission.orgId);
      agentId = (routes[0]?.agentId ?? 'sre') as AgentId;
      if (agentId === 'nexus') agentId = 'sre' as AgentId; // Avoid Nexus for status checks too
    }
    const agent = getAgent(agentId);

    // Update assignment
    await updateMissionItem(focusItem.id, { assignedAgentId: agentId });

    // Execute the agent
    const response = await executeAgent({
      orgId: mission.orgId,
      agentId,
      channelId: mission.channelId,
      userId: 'system',
      userName: 'Nexus (Mission Heartbeat)',
      userMessage: heartbeatMessage,
      needsCodeAccess: false,
      source: 'idle',
    });

    if (response && response !== '[error]') {
      await sendAgentMessage(mission.channelId, agent?.title ?? agentId, response, mission.orgId);
      await storeMessage({
        orgId: mission.orgId,
        channelId: mission.channelId,
        discordMessageId: `mission-resp-${Date.now()}`,
        authorId: 'agent',
        authorName: agent?.title ?? agentId,
        content: response,
        isAgent: true,
        agentId,
      });
    }
  }

  // Only verify agent_complete items if there are no pending/in_progress items to work on
  // (ticket creation is higher priority than verification)
  if (!focusItem) {
    const awaitingVerification = items.filter((i) => i.status === 'agent_complete');
    if (awaitingVerification.length > 0) {
      await verifyItem(mission, awaitingVerification[0], projects);
    }
  }

  // Post a brief status summary so the user has visibility
  const verified = items.filter(i => i.status === 'verified').length;
  const total = items.length;
  const statusLine = focusItem
    ? `Heartbeat: working on **${focusItem.title}** (${verified}/${total} complete)`
    : allStalled
      ? `Heartbeat: all items stalled, requesting Nexus to re-plan (${verified}/${total} complete)`
      : `Heartbeat: ${verified}/${total} items complete`;

  // Only post if something meaningful happened (agent responded or status changed)
  if (focusItem || allStalled) {
    localBus.emit('message', {
      id: `mission-status-${Date.now()}`,
      content: `**[Status]** ${statusLine}`,
      channel_id: mission.channelId,
      timestamp: new Date().toISOString(),
    });
  }

  // Schedule next heartbeat
  const nextAt = new Date(Date.now() + mission.heartbeatIntervalMs);
  await recordHeartbeat(mission.id, nextAt);
}

async function verifyItem(
  mission: Mission,
  item: { id: string; title: string; description: string; completedByAgentId: string | null },
  _projects: Array<{ name: string }>,
): Promise<void> {
  const verifyPrompt = `An agent has declared this mission item complete. Please verify:

**Item:** ${item.title}
**Verification Criteria:** ${item.description}
**Completed by:** ${item.completedByAgentId ?? 'unknown'}

If the item truly meets the criteria, verify it:
<mission-verify>{"itemId":"${item.id}"}</mission-verify>

If it does NOT meet the criteria, reopen it:
<mission-reopen>{"itemId":"${item.id}","reason":"What still needs to be done"}</mission-reopen>`;

  try {
    const response = await executeAgent({
      orgId: mission.orgId,
      agentId: 'nexus' as AgentId,
      channelId: mission.channelId,
      userId: 'system',
      userName: 'Mission Verifier',
      userMessage: verifyPrompt,
      needsCodeAccess: false,
      source: 'idle',
    });

    if (response && response !== '[error]') {
      await sendAgentMessage(mission.channelId, 'Nexus (Verification)', response, mission.orgId);
      await storeMessage({
        orgId: mission.orgId,
        channelId: mission.channelId,
        discordMessageId: `mission-verify-${Date.now()}`,
        authorId: 'agent',
        authorName: 'Nexus (Verification)',
        content: response,
        isAgent: true,
        agentId: 'nexus',
      });
    }
  } catch (err) {
    logger.error({ err, missionId: mission.id, itemId: item.id }, 'Item verification failed');
  }
}

async function spawnRecurrence(mission: Mission): Promise<void> {
  if (!mission.cronExpression) return;

  try {
    // Simple next-run calculation for common cron patterns
    // For MVP, just schedule next occurrence 1 week from now for weekly patterns
    const newMission = await createMission({
      orgId: mission.orgId,
      title: mission.title,
      description: mission.description,
      heartbeatIntervalMs: mission.heartbeatIntervalMs,
      cronExpression: mission.cronExpression,
    });

    logger.info(
      { parentId: mission.id, newMissionId: newMission.id },
      'Recurring mission spawned',
    );

    // Auto-plan the new mission
    planMission(newMission.id, mission.orgId).catch((err) =>
      logger.error({ err, missionId: newMission.id }, 'Auto-plan of recurring mission failed'),
    );
  } catch (err) {
    logger.error({ err, missionId: mission.id }, 'Failed to spawn recurring mission');
  }
}

export function stopMissionScheduler(): void {
  if (heartbeatHandle) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
  for (const timer of missionDebounceMap.values()) {
    clearTimeout(timer);
  }
  missionDebounceMap.clear();
}
