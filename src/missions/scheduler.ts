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

async function runMissionHeartbeat(mission: Mission): Promise<void> {
  const items = await getMissionItems(mission.id);
  const projects = await getMissionProjects(mission.id);

  // Find the first non-verified item to focus on
  const focusItem = items.find(
    (i) => i.status === 'pending' || i.status === 'in_progress',
  );

  // If any items are agent_complete, ask Nexus to verify
  const awaitingVerification = items.filter((i) => i.status === 'agent_complete');
  for (const item of awaitingVerification) {
    await verifyItem(mission, item, projects);
  }

  // Check completion
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

    const heartbeatMessage = `Checking in on Mission "${mission.title}" — focusing on: **${focusItem.title}**

**Checklist:**
${checklistSummary}

**Projects:** ${projectContext || 'None'}

${focusItem.description}

Please investigate and report your findings. If you've completed this item, declare it with:
<mission-item-complete>{"itemId":"${focusItem.id}","summary":"Brief summary of what was done"}</mission-item-complete>`;

    // Mark as in_progress
    if (focusItem.status === 'pending') {
      await updateMissionItem(focusItem.id, { status: 'in_progress' });
    }

    // Route to appropriate agent
    const routes = await routeMessage(
      heartbeatMessage,
      mission.channelId,
      'Nexus',
      mission.orgId,
    );

    const route = routes[0];
    const agentId = (route?.agentId ?? 'nexus') as AgentId;
    const agent = getAgent(agentId);

    // Update assignment
    await updateMissionItem(focusItem.id, { assignedAgentId: agentId });

    // Send heartbeat as a message in the mission channel
    await sendAgentMessage(mission.channelId, 'Nexus', heartbeatMessage, mission.orgId);
    await storeMessage({
      orgId: mission.orgId,
      channelId: mission.channelId,
      discordMessageId: `mission-hb-${Date.now()}`,
      authorId: 'agent',
      authorName: 'Nexus',
      content: heartbeatMessage,
      isAgent: true,
      agentId: 'nexus',
    });

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
    await executeAgent({
      orgId: mission.orgId,
      agentId: 'nexus' as AgentId,
      channelId: mission.channelId,
      userId: 'system',
      userName: 'Mission Verifier',
      userMessage: verifyPrompt,
      needsCodeAccess: false,
      source: 'idle',
    });
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
