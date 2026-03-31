import { executeAgent } from '../agents/executor.js';
import { logger } from '../logger.js';
import {
  getMission,
  getMissionItems,
  getMissionProjects,
  addMissionPhases,
  updateMissionStatus,
  dedupMissionItems,
  setMissionRoster,
} from './service.js';
import type { AgentId } from '../agents/types.js';
import { getAllAgents } from '../agents/registry.js';

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

  // Build agent list for roster selection
  const allAgents = getAllAgents();
  const agentList = allAgents.map(a => `- ${a.id}: ${a.title}`).join('\n');

  const planningPrompt = `You are planning a mission. Do two things:

1. Break this goal into 5-10 major PHASES — high-level workstreams that represent key milestones.
2. Select 2-5 AGENTS from the team who are most relevant to this mission's work. Do NOT include "nexus" — you (Nexus) always have access as the orchestrator.

**Mission Title:** ${mission.title}
**Mission Description:** ${mission.description}

**Linked Projects:**
${projectContext}

**Available Agents:**
${agentList}

Respond with ONLY a JSON object (not an array):
{
  "phases": [
    {"title": "Phase name", "description": "What must be true for this phase to be considered complete"}
  ],
  "agents": ["agent-id-1", "agent-id-2"]
}

Example:
{
  "phases": [
    {"title": "Payment provider integration", "description": "Stripe SDK connected, test charges succeed in sandbox"},
    {"title": "Checkout flow", "description": "Users can complete a purchase end-to-end in the UI"}
  ],
  "agents": ["product-manager", "ux-designer", "sre"]
}

IMPORTANT: Phases should be 5-10 max. Agents should be 2-5 — only those directly relevant to the mission goal. Output ONLY the JSON object, no other text.`;

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
      // Try to parse as { phases: [...], agents: [...] } object first, fall back to array
      const jsonObjMatch = response.match(/\{[\s\S]*\}/);
      const jsonArrMatch = response.match(/\[[\s\S]*\]/);
      const jsonMatch = jsonObjMatch || jsonArrMatch;

      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          let phases: Array<{ title: string; description: string }>;
          let agentIds: string[] = [];

          if (parsed.phases && Array.isArray(parsed.phases)) {
            // New format: { phases: [...], agents: [...] }
            phases = parsed.phases;
            agentIds = Array.isArray(parsed.agents) ? parsed.agents : [];
          } else if (Array.isArray(parsed)) {
            // Legacy format: [...]
            phases = parsed;
          } else {
            phases = [];
          }

          if (phases.length > 0) {
            await addMissionPhases(missionId, phases);
            logger.info({ missionId, phaseCount: phases.length }, 'Mission phases created from planning');
          } else {
            logger.warn({ missionId, response: response.slice(0, 300) }, 'Mission planning returned empty phases');
          }

          // Set agent roster (validate IDs against actual agents)
          if (agentIds.length > 0) {
            const validIds = new Set(allAgents.map(a => a.id));
            const validRoster = agentIds.filter(id => validIds.has(id as any) && id !== 'nexus');
            if (validRoster.length > 0) {
              await setMissionRoster(missionId, validRoster);
              logger.info({ missionId, roster: validRoster }, 'Mission agent roster set from planning');
            }
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

  // Mission is complete when ALL phases are verified by Nexus
  // (not when sub-steps are all done — that's just progress, not goal completion)
  const allPhasesComplete = progress.every(({ phase }) => phase.status === 'verified');

  if (allPhasesComplete) {
    await updateMissionStatus(missionId, orgId, 'completed');
    logger.info({ missionId }, 'Mission completed — all phases verified');
    return true;
  }
  return false;
}
