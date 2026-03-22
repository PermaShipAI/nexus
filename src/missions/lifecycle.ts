import { executeAgent } from '../agents/executor.js';
import { logger } from '../logger.js';
import {
  getMission,
  getMissionItems,
  getMissionProjects,
  addMissionItems,
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

  const planningPrompt = `You are planning a mission. Generate a checklist of verifiable outcome items for this goal.

**Mission Title:** ${mission.title}
**Mission Description:** ${mission.description}

**Linked Projects:**
${projectContext}

Respond with ONLY a JSON array of checklist items. Each item must have:
- "title": Short title for the checklist item
- "description": How to verify this outcome is complete

Example:
[
  {"title": "Add input validation", "description": "All API endpoints validate request bodies and return 400 on invalid input"},
  {"title": "Write unit tests", "description": "Test coverage for validation logic reaches 80%+"}
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
            await addMissionItems(missionId, items);
            logger.info({ missionId, itemCount: items.length }, 'Mission items created from planning');
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
 * Check if all mission items are verified.
 * If so, transition to completed.
 */
export async function checkMissionCompletion(missionId: string, orgId: string): Promise<boolean> {
  const items = await getMissionItems(missionId);
  if (items.length === 0) return false;

  const allVerified = items.every((item) => item.status === 'verified');
  if (allVerified) {
    await updateMissionStatus(missionId, orgId, 'completed');
    logger.info({ missionId }, 'Mission completed — all items verified');
    return true;
  }
  return false;
}
