import { executeAgent } from '../agents/executor.js';
import { logger } from '../logger.js';
import {
  getMission,
  getMissionItems,
  getMissionProjects,
  addMissionPhases,
  updateMissionStatus,
  dedupMissionItems,
} from './service.js';
import type { AgentId } from '../agents/types.js';

/**
 * Plan a mission: draft → planning → active.
 * Nexus generates checklist items for the mission goal.
 */
export async function planMission(missionId: string, orgId: string): Promise<void> {
  const mission = await getMission(missionId, orgId);
  if (!mission) throw new Error(`Mission ${missionId} not found`);

  if (mission.status !== 'draft') {
    throw new Error(
      `Cannot plan mission ${missionId}: invalid state transition from '${mission.status}'. Expected 'draft'.`,
    );
  }

  // Clean up any duplicate items from previous planning runs
  const removed = await dedupMissionItems(missionId);
  if (removed > 0) logger.info({ missionId, removed }, 'Removed duplicate mission items');

  // Transition to planning
  await updateMissionStatus(missionId, orgId, 'planning');

  // Gather project context
  const projects = await getMissionProjects(missionId);
  const projectContext = projects.length > 0
    ? projects.map((p) => `- **${p.name}** (${p.localPath})`).join('\n')
    : 'No projects linked.';

  const planningPrompt = `You are planning a mission. Break this goal into 5-10 major PHASES — high-level workstreams that represent the key milestones.

**Mission Title:** ${mission.title}
**Mission Description:** ${mission.description}

**Linked Projects:**
${projectContext}

IMPORTANT: Create only the major phases (5-10 max). Each phase should be a significant milestone, NOT a small task. Detailed sub-steps will be added later as work progresses.

Respond with ONLY a JSON array of phases:
[
  {"title": "Phase name", "description": "What must be true for this phase to be considered complete"}
]

Example for a "Build a payment system" mission:
[
  {"title": "Payment provider integration", "description": "Stripe SDK connected, test charges succeed in sandbox"},
  {"title": "Checkout flow", "description": "Users can complete a purchase end-to-end in the UI"},
  {"title": "Subscription management", "description": "Users can upgrade, downgrade, and cancel subscriptions"},
  {"title": "Billing dashboard", "description": "Admin can view revenue, refunds, and subscription metrics"}
]

Output ONLY the JSON array, no other text.`;

  try {
    const response = await executeAgent({
      orgId,
      agentId: 'nexus' as AgentId,
      channelId: mission.channelId,
      userId: 'system',
      userName: 'Mission Planner',
      userMessage: planningPrompt,
      needsCodeAccess: false,
      source: 'idle',
    });

    if (response) {
      // Extract JSON array from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const items = JSON.parse(jsonMatch[0]) as Array<{ title: string; description: string }>;
          if (Array.isArray(items) && items.length > 0) {
            await addMissionPhases(missionId, items);
            logger.info({ missionId, phaseCount: items.length }, 'Mission phases created from planning');
          } else {
            logger.warn({ missionId, response: response.slice(0, 300) }, 'Mission planning returned empty items array');
          }
        } catch (parseErr) {
          logger.warn({ missionId, parseErr, jsonSnippet: jsonMatch[0].slice(0, 200) }, 'Failed to parse mission planning JSON');
        }
      } else {
        logger.warn({ missionId, response: response.slice(0, 500) }, 'Mission planning response contained no JSON array');
      }
    } else {
      logger.warn({ missionId }, 'Mission planning returned null response from LLM');
    }
  } catch (err) {
    logger.error({ err, missionId }, 'Mission planning failed');
  }

  // Transition to active
  const now = new Date();
  const m = await getMission(missionId, orgId);
  const intervalMs = m?.heartbeatIntervalMs ?? 600_000;
  await updateMissionStatus(missionId, orgId, 'active');

  // Set first heartbeat
  const { recordHeartbeat } = await import('./service.js');
  await recordHeartbeat(missionId, new Date(now.getTime() + intervalMs));

  logger.info({ missionId }, 'Mission planning complete, now active');
}

/**
 * Check if all phases are complete.
 * A phase is complete when all its sub-steps are verified (or it has no sub-steps and is verified itself).
 */
export async function checkMissionCompletion(missionId: string, orgId: string): Promise<boolean> {
  const { getMissionPhaseProgress } = await import('./service.js');
  const progress = await getMissionPhaseProgress(missionId);
  if (progress.length === 0) return false;

  const allPhasesComplete = progress.every(({ phase, subSteps, completedSubSteps, totalSubSteps }) => {
    if (totalSubSteps === 0) return phase.status === 'verified';
    return completedSubSteps === totalSubSteps;
  });

  if (allPhasesComplete) {
    await updateMissionStatus(missionId, orgId, 'completed');
    logger.info({ missionId }, 'Mission completed — all phases verified');
    return true;
  }
  return false;
}
