import { spawn } from 'node:child_process';
import { writeGeminiContext, buildAgentPrompt } from './prompt-builder.js';
import { getLLMProvider, getSourceExplorer, getWorkspaceProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';
import { logToolStrippingEvent } from '../../agents/telemetry/logger.js';
import type { AgentId } from './types.js';
import type { LLMContent } from '../adapters/interfaces/llm-provider.js';
import { db } from '../db/index.js';
import { pendingActions } from '../db/schema.js';
import { and, eq, isNull, gte } from 'drizzle-orm';
import { createTicketProposal } from '../tools/proposal-service.js';

import type { TicketProposalInput } from '../tools/proposal-service.js';
import { getTicketTracker } from '../adapters/registry.js';
import { resolveAutonomousMode } from '../settings/service.js';
import { updateProjectSettings } from '../tools/update_project_settings.js';
import { getMissionItem, updateMissionItem, addMissionItems } from '../missions/service.js';
import { onMissionItemChanged } from '../missions/scheduler.js';
import { checkAndTriggerAdrDrafting } from './adr-service.js';
import { shouldCreateSuggestion } from '../idle/throttle.js';
import { sendApprovalMessage, sendAutonomousNotification, sendPublicChannelAlerts } from '../bot/interactions.js';
import { getAgent } from './registry.js';
import { parseArgs } from '../utils/parse-args.js';
import { CODE_TOOL_DECLARATIONS, executeCodeTool } from './code-tools.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ?? (process.env.NODE_ENV === 'production' ? '/app' : process.cwd());
const GEMINI_TIMEOUT_MS = 19 * 60 * 1000; // 19 minutes
const MAX_TOOL_ROUNDS = 6;
const DEEP_RESEARCH_MAX_TURNS = 25;
const DEEP_RESEARCH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface SteeringContext {
  originalActionId: string;
  previousProposal: string;
  userFeedback: string;
}

export interface ExecuteAgentInput {
  orgId: string;
  agentId: AgentId;
  channelId: string;
  userId: string;
  userName: string;
  userMessage: string;
  /** If true, spawn Gemini CLI with codebase tools. If false, use fast Gemini API. */
  needsCodeAccess?: boolean;
  /** Origin of this execution: 'user' for Slack/Discord messages, 'idle' for system-initiated */
  source?: 'user' | 'idle';
  onActionQueued?: (actionId: string, description: string) => Promise<void>;
  steering?: SteeringContext;
  /** If true, strip all mutative XML tool instructions from the prompt and skip XML action block parsing. */
  isStrictConsultation?: boolean;
  /** If true, use deep research mode with a cloned workspace (Plan B). */
  needsDeepResearch?: boolean;
}

export async function executeAgent(input: ExecuteAgentInput): Promise<string | null> {
  // StrictConsultation always forces the fast path — no codebase access allowed
  if (input.isStrictConsultation) {
    input = { ...input, needsCodeAccess: false, needsDeepResearch: false };
  }

  const { needsCodeAccess, needsDeepResearch } = input;

  // Deep research: cloned workspace with extended tool set
  if (needsDeepResearch && getWorkspaceProvider() !== null) {
    return executeDeepResearch(input);
  }

  // Fast path: Gemini API (no CLI subprocess overhead)
  // Always use fast path when using embedded PGlite (CLI subprocesses can't access it)
  // or in production containers where CLI tools aren't available
  const useEmbeddedDb = !process.env.DATABASE_URL;
  if (needsCodeAccess === false || process.env.NODE_ENV === 'production' || useEmbeddedDb) {
    return executeFast(input);
  }

  // Full path: spawn Gemini CLI with codebase access (requires external PostgreSQL)
  return executeCli(input);
}

/** Fast API-based execution for conversational messages */
async function executeFast(input: ExecuteAgentInput): Promise<string | null> {
  const { orgId, agentId, channelId, userMessage, steering, source } = input;
  logger.info({ orgId, agentId, messageLength: userMessage.length }, 'Fast path: calling Gemini API');
  const executionStart = new Date();

  try {
    if (input.isStrictConsultation) {
      logToolStrippingEvent({ agentId, orgId, intent: 'StrictConsultation' });
    }

    const explorer = getSourceExplorer();
    const hasCodeTools = input.needsCodeAccess !== false && explorer !== null;
    const promptOptions = input.isStrictConsultation
      ? { stripMutativeTools: true }
      : hasCodeTools
        ? { hasCodeTools: true }
        : undefined;
    const systemPrompt = await buildAgentPrompt(agentId, channelId, orgId, promptOptions);

    let fullUserMessage = userMessage;
    if (steering) {
      fullUserMessage = `
USER FEEDBACK on your previous proposal:
"${steering.userFeedback}"

YOUR PREVIOUS PROPOSAL:
"${steering.previousProposal}"

Please refine your proposal based on this feedback.
`.trim();
    }

    let response: string;

    if (hasCodeTools && explorer) {
      // Tool-use loop: multi-turn conversation with code exploration tools
      response = await executeToolLoop({
        orgId,
        systemPrompt,
        userMessage: fullUserMessage,
        explorer,
        maxRounds: MAX_TOOL_ROUNDS,
        modelTier: 'AGENT',
      });
    } else {
      // Single-shot: no code tools available
      response = await getLLMProvider().generateText({
        model: 'AGENT',
        orgId,
        systemInstruction: systemPrompt,
        contents: [{ role: 'user', parts: [{ text: fullUserMessage }] }],
      });
    }

    if (!response || response.trim().length === 0) {
      logger.warn({ agentId }, 'Gemini API returned empty response');
      return null;
    }

    // Strip thought blocks
    let cleaned = response.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
    logger.info({ agentId, outputLength: cleaned.length }, 'Gemini API response received');

    // Debug: log response snippet and check for proposal-related content
    const hasProposalTag = cleaned.includes('<ticket-proposal');
    const hasProposalMention = cleaned.toLowerCase().includes('ticket') && cleaned.toLowerCase().includes('proposal');
    if (source === 'idle') {
      logger.info(
        { agentId, orgId, hasProposalTag, hasProposalMention, snippet: cleaned.slice(0, 300) },
        'Idle agent response diagnostic',
      );
    }

    if (!input.isStrictConsultation) {
      // Extract and process <ticket-proposal> blocks
      const proposalRegex = /<ticket-proposal>\s*([\s\S]*?)(?:<\/ticket-proposal>|$)/gi;
      const proposalBlocks: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = proposalRegex.exec(cleaned)) !== null) {
        if (match[1].trim()) proposalBlocks.push(match[1].trim());
      }

      if (proposalBlocks.length > 0) {
        logger.info({ agentId, orgId, count: proposalBlocks.length }, 'Extracted ticket-proposal blocks');
      }

      // Strip proposal blocks from the response
      cleaned = cleaned.replace(/<ticket-proposal>\s*[\s\S]*?(?:<\/ticket-proposal>|$)/gi, '').trim();


      // Process each proposal
      for (const block of proposalBlocks) {
        try {
          const parsed = JSON.parse(block) as Partial<TicketProposalInput>;
          if (!parsed.kind || !parsed.title || !parsed.description || !parsed.project) {
            logger.warn({ agentId, block }, 'Skipping malformed ticket-proposal: missing required fields');
            continue;
          }
          const result = await createTicketProposal({
            orgId,
            kind: parsed.kind,
            title: parsed.title,
            description: parsed.description,
            project: parsed.project,
            repoKey: parsed.repoKey,
            agentId,
            source,
            agentDiscussionContext: parsed.agentDiscussionContext,
            fallbackPlan: parsed.fallbackPlan,
          });
          logger.info({ agentId, result }, 'Fast path ticket proposal processed');
        } catch (err) {
          logger.warn({ err, agentId, block }, 'Failed to parse/process ticket-proposal block');
        }
      }

      // Extract and process <approve-proposal> blocks (Nexus fast path)
      const approveRegex = /<approve-proposal>\s*([\s\S]*?)(?:\s*<\/approve-proposal>|$)/gi;
      while ((match = approveRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as { id: string; reason: string };

          if (!parsed.id || !parsed.reason) {
            logger.warn({ agentId, block: match[1] }, 'Skipping malformed approve-proposal: missing id or reason');
            continue;
          }
          const [action] = await db.select().from(pendingActions).where(eq(pendingActions.id, parsed.id)).limit(1);
          if (!action) {
            logger.warn({ agentId, actionId: parsed.id }, 'approve-proposal: action not found');
            continue;
          }
          const existingArgs = parseArgs(action.args);
          const updatedArgs: Record<string, unknown> = { ...existingArgs, ctoDecisionReason: parsed.reason };
          await db.update(pendingActions)
            .set({ status: 'pending', args: updatedArgs })
            .where(eq(pendingActions.id, parsed.id));
          logger.info({ agentId, actionId: parsed.id }, 'Fast path: proposal approved by Nexus');

          // Immediately create suggestion / ticket for the approved proposal
          try {
            const autonomous = await resolveAutonomousMode({ orgId, channelId, repoKey: updatedArgs['repo-key'] as string | undefined });
            if (autonomous) {
              // Auto-create ticket
              const ticketResult = await getTicketTracker().createTicket({
                orgId,
                kind: (updatedArgs.kind as 'bug' | 'feature' | 'task') ?? 'task',
                title: updatedArgs.title as string,
                description: updatedArgs.description as string,
                repoKey: updatedArgs['repo-key'] as string,
                projectId: updatedArgs['project-id'] as string,
                priority: updatedArgs.priority ? parseInt(updatedArgs.priority as string, 10) : undefined,
                createdByAgentId: action.agentId as AgentId,
              });
              await db.update(pendingActions)
                .set({ status: 'approved', resolvedAt: new Date() })
                .where(eq(pendingActions.id, parsed.id));
              await sendAutonomousNotification(channelId, getAgent(action.agentId as AgentId)?.title ?? action.agentId, parsed.id, ticketResult);
              sendPublicChannelAlerts(
                (updatedArgs.kind as string) ?? 'task',
                (updatedArgs.title as string) ?? 'Untitled',
                orgId,
              ).catch((err) => logger.error({ err }, 'Failed to send public channel alerts'));
            } else {
              // Create suggestion for human review (throttle check: skip if backlogged, unless user-initiated)
              const canCreate = await shouldCreateSuggestion(orgId, action.source);
              if (canCreate) {
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
                    .where(eq(pendingActions.id, parsed.id));
                  logger.info({ actionId: parsed.id, suggestionId: suggestionResult.suggestionId }, 'Suggestion created for fast-path approved proposal');
                } else {
                  logger.error({ actionId: parsed.id, error: suggestionResult.error }, 'Failed to create suggestion for fast-path approved proposal');
                }
                // Send approval message with buttons
                const proposingAgent = getAgent(action.agentId as AgentId);
                await sendApprovalMessage(channelId, proposingAgent?.title ?? action.agentId, parsed.id, action.description);
              } else {
                logger.info({ actionId: parsed.id, source: action.source }, 'Suggestion creation throttled for fast-path approved proposal');
              }
            }
          } catch (err) {
            logger.error({ err, actionId: parsed.id }, 'Error creating suggestion/ticket for fast-path approved proposal');
          }
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process approve-proposal block');
        }
      }
      cleaned = cleaned.replace(/<approve-proposal>\s*([\s\S]*?)(?:\s*<\/approve-proposal>|$)/gi, '').trim();


      // Extract and process <revalidate-proposal> blocks (staleness revalidation)
      const revalidateRegex = /<revalidate-proposal\s+id="([^"]+)"\s*\/?>/g;
      while ((match = revalidateRegex.exec(cleaned)) !== null) {
        try {
          const actionId = match[1];
          const [action] = await db.select().from(pendingActions).where(eq(pendingActions.id, actionId)).limit(1);
          if (!action) {
            logger.warn({ agentId, actionId }, 'revalidate-proposal: action not found');
            continue;
          }
          await db.update(pendingActions)
            .set({
              lastStalenessCheckAt: new Date(),
              stalenessCount: (action.stalenessCount ?? 0) + 1,
            })
            .where(eq(pendingActions.id, actionId));
          logger.info({ agentId, actionId }, 'Proposal revalidated by agent');
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to process revalidate-proposal block');
        }
      }
      cleaned = cleaned.replace(/<revalidate-proposal\s+id="[^"]+"\s*\/?>/g, '').trim();

      // Extract and process <withdraw-proposal> blocks (staleness withdrawal)
      const withdrawRegex = /<withdraw-proposal\s+id="([^"]+)">([\s\S]*?)(?:<\/withdraw-proposal>|$)/gi;
      while ((match = withdrawRegex.exec(cleaned)) !== null) {

        try {
          const actionId = match[1];
          const reason = match[2].trim();
          const [action] = await db.select().from(pendingActions).where(eq(pendingActions.id, actionId)).limit(1);
          if (!action) {
            logger.warn({ agentId, actionId }, 'withdraw-proposal: action not found');
            continue;
          }
          const updatedArgs: Record<string, unknown> = { ...parseArgs(action.args), withdrawReason: reason };
          await db.update(pendingActions)
            .set({ status: 'rejected', args: updatedArgs, resolvedAt: new Date() })
            .where(eq(pendingActions.id, actionId));
          logger.info({ agentId, actionId, reason }, 'Proposal withdrawn by agent');
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to process withdraw-proposal block');
        }
      }
      cleaned = cleaned.replace(/<withdraw-proposal\s+id="[^"]+">[\s\S]*?(?:<\/withdraw-proposal>|$)/gi, '').trim();


      // Extract and process <reject-proposal> blocks (Nexus fast path)
      const rejectRegex = /<reject-proposal>\s*([\s\S]*?)(?:\s*<\/reject-proposal>|$)/gi;
      while ((match = rejectRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as { id: string; reason: string };

          if (!parsed.id || !parsed.reason) {
            logger.warn({ agentId, block: match[1] }, 'Skipping malformed reject-proposal: missing id or reason');
            continue;
          }
          const [action] = await db.select().from(pendingActions).where(eq(pendingActions.id, parsed.id)).limit(1);
          if (!action) {
            logger.warn({ agentId, actionId: parsed.id }, 'reject-proposal: action not found');
            continue;
          }
          const updatedArgs: Record<string, unknown> = { ...parseArgs(action.args), ctoRejectionReason: parsed.reason };
          await db.update(pendingActions)
            .set({ status: 'rejected', args: updatedArgs, resolvedAt: new Date() })
            .where(eq(pendingActions.id, parsed.id));
          logger.info({ agentId, actionId: parsed.id }, 'Fast path: proposal rejected by Nexus');

          // Async ADR pattern detection — does not block the response
          checkAndTriggerAdrDrafting(orgId).catch((err) =>
            logger.warn({ err, orgId }, 'ADR drafting check failed (non-fatal)'),
          );
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process reject-proposal block');
        }
      }
      cleaned = cleaned.replace(/<reject-proposal>\s*([\s\S]*?)(?:\s*<\/reject-proposal>|$)/gi, '').trim();


      // Extract and process <defer-proposal> blocks (Nexus fast path — proposal needs revision)
      const deferRegex = /<defer-proposal>\s*([\s\S]*?)(?:\s*<\/defer-proposal>|$)/gi;
      while ((match = deferRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as { id: string; reason: string; feedback?: string };

          if (!parsed.id || !parsed.reason) {
            logger.warn({ agentId, block: match[1] }, 'Skipping malformed defer-proposal: missing id or reason');
            continue;
          }
          const [action] = await db.select().from(pendingActions).where(eq(pendingActions.id, parsed.id)).limit(1);
          if (!action) {
            logger.warn({ agentId, actionId: parsed.id }, 'defer-proposal: action not found');
            continue;
          }
          const updatedArgs: Record<string, unknown> = {
            ...parseArgs(action.args),
            ctoDeferralReason: parsed.reason,
            ctoDeferralFeedback: parsed.feedback ?? parsed.reason,
          };
          // Keep status as nexus_review but record the reason
          await db.update(pendingActions)
            .set({ args: updatedArgs })
            .where(eq(pendingActions.id, parsed.id));
          logger.info({ agentId, actionId: parsed.id, reason: parsed.reason }, 'Fast path: proposal deferred by Nexus');
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process defer-proposal block');
        }
      }
      cleaned = cleaned.replace(/<defer-proposal>\s*([\s\S]*?)(?:\s*<\/defer-proposal>|$)/gi, '').trim();


      // Extract and process <mission-item-complete> blocks
      const missionCompleteRegex = /<mission-item-complete>\s*([\s\S]*?)(?:<\/mission-item-complete>|$)/gi;
      while ((match = missionCompleteRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as { itemId: string; summary: string };
          if (!parsed.itemId) {
            logger.warn({ agentId, block: match[1] }, 'Skipping malformed mission-item-complete: missing itemId');
            continue;
          }
          const completedItem = await getMissionItem(parsed.itemId);
          await updateMissionItem(parsed.itemId, {
            status: 'agent_complete',
            completedByAgentId: agentId,
          });
          logger.info({ agentId, itemId: parsed.itemId }, 'Mission item marked agent_complete');
          if (completedItem) onMissionItemChanged(completedItem.missionId);
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process mission-item-complete block');
        }
      }
      cleaned = cleaned.replace(/<mission-item-complete>\s*[\s\S]*?(?:<\/mission-item-complete>|$)/gi, '').trim();

      // Extract and process <mission-verify> blocks (Nexus only)
      const missionVerifyRegex = /<mission-verify>\s*([\s\S]*?)(?:<\/mission-verify>|$)/gi;
      while ((match = missionVerifyRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as { itemId: string };
          if (!parsed.itemId) continue;
          const verifiedItem = await getMissionItem(parsed.itemId);
          await updateMissionItem(parsed.itemId, {
            status: 'verified',
            verifiedAt: new Date(),
          });
          logger.info({ agentId, itemId: parsed.itemId }, 'Mission item verified');
          if (verifiedItem) onMissionItemChanged(verifiedItem.missionId);
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process mission-verify block');
        }
      }
      cleaned = cleaned.replace(/<mission-verify>\s*[\s\S]*?(?:<\/mission-verify>|$)/gi, '').trim();

      // Extract and process <mission-reopen> blocks (Nexus only)
      const missionReopenRegex = /<mission-reopen>\s*([\s\S]*?)(?:<\/mission-reopen>|$)/gi;
      while ((match = missionReopenRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as { itemId: string; reason: string };
          if (!parsed.itemId) continue;
          await updateMissionItem(parsed.itemId, { status: 'in_progress', heartbeatCount: 1 });
          logger.info({ agentId, itemId: parsed.itemId, reason: parsed.reason }, 'Mission item reopened');
          // NOTE: do NOT trigger onMissionItemChanged here — reopening should
          // wait for the normal heartbeat cycle, not trigger an early one that
          // re-enters the verify loop.
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process mission-reopen block');
        }
      }
      cleaned = cleaned.replace(/<mission-reopen>\s*[\s\S]*?(?:<\/mission-reopen>|$)/gi, '').trim();

      // Extract and process <mission-add-items> blocks — agents can add new checklist items
      const missionAddItemsRegex = /<mission-add-items>\s*([\s\S]*?)(?:<\/mission-add-items>|$)/gi;
      while ((match = missionAddItemsRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as { missionId: string; items: Array<{ title: string; description: string }> };
          if (!parsed.missionId || !parsed.items?.length) {
            logger.warn({ agentId, block: match[1] }, 'Skipping malformed mission-add-items');
            continue;
          }
          await addMissionItems(parsed.missionId, parsed.items);
          logger.info({ agentId, missionId: parsed.missionId, count: parsed.items.length }, 'Mission items added by agent');
          onMissionItemChanged(parsed.missionId);
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process mission-add-items block');
        }
      }
      cleaned = cleaned.replace(/<mission-add-items>\s*[\s\S]*?(?:<\/mission-add-items>|$)/gi, '').trim();

      // Extract and process <mission-replace-item> blocks — break a stalled item into sub-items
      const missionReplaceRegex = /<mission-replace-item>\s*([\s\S]*?)(?:<\/mission-replace-item>|$)/gi;
      while ((match = missionReplaceRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as {
            itemId: string;
            reason: string;
            replacements: Array<{ title: string; description: string }>;
          };
          if (!parsed.itemId || !parsed.replacements?.length) {
            logger.warn({ agentId, block: match[1] }, 'Skipping malformed mission-replace-item');
            continue;
          }
          const item = await getMissionItem(parsed.itemId);
          if (!item) continue;

          // Mark the original item as completed (replaced)
          await updateMissionItem(parsed.itemId, {
            status: 'verified',
            completedByAgentId: agentId,
          });

          // Add replacement sub-items
          await addMissionItems(item.missionId, parsed.replacements);
          logger.info({ agentId, itemId: parsed.itemId, replacementCount: parsed.replacements.length, reason: parsed.reason }, 'Mission item replaced with sub-items');
          onMissionItemChanged(item.missionId);
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process mission-replace-item block');
        }
      }
      cleaned = cleaned.replace(/<mission-replace-item>\s*[\s\S]*?(?:<\/mission-replace-item>|$)/gi, '').trim();

      // Extract and process <mission-remove-item> blocks (Nexus only)
      const missionRemoveRegex = /<mission-remove-item>\s*([\s\S]*?)(?:<\/mission-remove-item>|$)/gi;
      while ((match = missionRemoveRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as { itemId: string; reason: string };
          if (!parsed.itemId) continue;
          // Mark as verified (effectively removes it from the active checklist)
          await updateMissionItem(parsed.itemId, {
            status: 'verified',
            completedByAgentId: 'removed',
          });
          logger.info({ agentId, itemId: parsed.itemId, reason: parsed.reason }, 'Mission item removed');
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process mission-remove-item block');
        }
      }
      cleaned = cleaned.replace(/<mission-remove-item>\s*[\s\S]*?(?:<\/mission-remove-item>|$)/gi, '').trim();

      // Extract and process <update-settings> blocks
      const updateSettingsRegex = /<update-settings>\s*([\s\S]*?)(?:\s*<\/update-settings>|$)/gi;
      while ((match = updateSettingsRegex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[1].trim()) as {

            project_id?: unknown;
            setting_key?: unknown;
            value?: unknown;
            confirmation_token?: unknown;
          };
          if (!parsed.project_id || !parsed.setting_key || parsed.value === undefined) {
            logger.warn(
              { agentId, block: match[1] },
              'Skipping malformed update-settings: missing required fields (project_id, setting_key, value)',
            );
            continue;
          }
          const result = await updateProjectSettings({
            orgId,
            project_id: parsed.project_id as string,
            setting_key: parsed.setting_key as string,
            value: parsed.value,
            confirmation_token: typeof parsed.confirmation_token === 'string' ? parsed.confirmation_token : undefined,
            agentId,
          });
          logger.info({ agentId, result }, 'Fast path update-settings processed');
        } catch (err) {
          logger.warn({ err, agentId }, 'Failed to parse/process update-settings block');
        }
      }
      cleaned = cleaned.replace(/<update-settings>\s*([\s\S]*?)(?:\s*<\/update-settings>|$)/gi, '').trim();


    }

    await checkPendingActions(input, executionStart);

    // Suppress verbose response if agent created proposals during this execution
    const proposalCount = await agentCreatedProposalsSince(agentId, orgId, executionStart);
    return suppressProposalDetails(agentId, cleaned, proposalCount);
  } catch (err) {
    logger.error({ err, agentId, source }, 'Gemini API execution failed');
    // For user-initiated messages, return an error indicator instead of silent null
    if (source === 'user') {
      return '[error]';
    }
    return null;
  }
}

/** Full CLI-based execution with codebase access */
async function executeCli(input: ExecuteAgentInput): Promise<string | null> {
  const { orgId, agentId, channelId, userMessage, steering } = input;

  const { cleanup } = await writeGeminiContext(agentId, channelId, orgId);
  const executionStart = new Date();

  try {
    logger.info({ orgId, agentId, messageLength: userMessage.length }, 'Spawning Gemini CLI');

    let fullPrompt = userMessage;
    if (steering) {
      fullPrompt = `
REVISE PROPOSAL based on user feedback.

USER FEEDBACK:
"${steering.userFeedback}"

YOUR PREVIOUS PROPOSAL:
"${steering.previousProposal}"

Please refine your proposal based on this feedback.
`.trim();
    }

    const args = [
      'src/tools/cli.ts',
      'execute-agent',
      '--agent', agentId,
      '--channel', channelId,
      '--org', orgId,
      '--prompt', fullPrompt,
    ];


    const child = spawn('npx', ['tsx', ...args], {
      cwd: WORKSPACE_ROOT,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const exitPromise = new Promise<number>((resolve) => {
      child.on('close', resolve);
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), GEMINI_TIMEOUT_MS);
    });

    const exitCode = await Promise.race([exitPromise, timeoutPromise]);

    if (exitCode === null) {
      child.kill();
      logger.error({ agentId }, 'Gemini CLI timed out');
      return 'The operation timed out. I will continue investigating.';
    }

    if (exitCode !== 0) {
      logger.error({ agentId, exitCode, stderr }, 'Gemini CLI failed');
      return null;
    }

    await checkPendingActions(input, executionStart);

    const proposalCount = await agentCreatedProposalsSince(agentId, orgId, executionStart);
    return suppressProposalDetails(agentId, stdout, proposalCount);
  } catch (err) {
    logger.error({ err, agentId }, 'Gemini CLI execution failed');
    return null;
  } finally {
    await cleanup();
  }
}

/**
 * Multi-turn tool-use loop: calls the LLM with code tools, executes tool calls,
 * and feeds results back until the LLM produces a final text response.
 */
async function executeToolLoop(opts: {
  orgId: string;
  systemPrompt: string;
  userMessage: string;
  explorer: import('../adapters/interfaces/source-explorer.js').SourceExplorer;
  maxRounds: number;
  modelTier: import('../adapters/interfaces/llm-provider.js').ModelTier;
}): Promise<string> {
  const { orgId, systemPrompt, userMessage, explorer, maxRounds, modelTier } = opts;
  const contents: LLMContent[] = [{ role: 'user', parts: [{ text: userMessage }] }];

  for (let round = 0; round < maxRounds; round++) {
    const result = await getLLMProvider().generateWithTools({
      model: modelTier,
      orgId,
      systemInstruction: systemPrompt,
      contents,
      tools: CODE_TOOL_DECLARATIONS,
    });

    if (result.functionCalls.length === 0) {
      // No tool calls — this is the final text response
      return result.text ?? '';
    }

    logger.info({ round, toolCalls: result.functionCalls.map(fc => fc.name), orgId }, 'Tool-use round');

    // Build model turn with functionCall parts (include id for provider correlation)
    const modelParts: LLMContent['parts'] = [];
    if (result.text) {
      modelParts.push({ text: result.text });
    }
    for (const fc of result.functionCalls) {
      const callId = fc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
      modelParts.push({ functionCall: { name: fc.name, args: fc.args, id: callId } });
    }
    contents.push({ role: 'model', parts: modelParts });

    // Execute each tool call and build functionResponse parts
    const responseParts: LLMContent['parts'] = [];
    for (let i = 0; i < result.functionCalls.length; i++) {
      const fc = result.functionCalls[i];
      const callId = (modelParts.find(p => p.functionCall?.name === fc.name) as any)?.functionCall?.id ?? fc.id;
      const toolResult = await executeCodeTool(fc.name, fc.args, { orgId, explorer });
      responseParts.push({
        functionResponse: { name: fc.name, response: { result: toolResult }, id: callId },
      });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  // Exhausted rounds — force a final text response
  contents.push({ role: 'user', parts: [{ text: 'You have used all available tool rounds. Please provide your final answer now based on what you have learned.' }] });
  const finalResponse = await getLLMProvider().generateText({
    model: modelTier,
    orgId,
    systemInstruction: systemPrompt,
    contents,
  });
  return finalResponse;
}

/** Process deep research result through the fast path for XML action block parsing. */
async function processDeepResearchResult(input: ExecuteAgentInput, response: string, executionStart: Date): Promise<string | null> {
  // Strip thought blocks and run through the same XML action block parsing as executeFast
  // by calling executeFast with the response as a pre-computed result
  // For simplicity, just do the post-processing inline
  const { agentId, orgId } = input;
  let cleaned = response.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
  await checkPendingActions(input, executionStart);
  const proposalCount = await agentCreatedProposalsSince(agentId, orgId, executionStart);
  return suppressProposalDetails(agentId, cleaned, proposalCount);
}

/** Deep research mode: clone workspace and explore with extended tools and budget. */
async function executeDeepResearch(input: ExecuteAgentInput): Promise<string | null> {
  const { orgId, agentId, channelId, userMessage, steering } = input;
  logger.info({ orgId, agentId }, 'Deep research: starting');
  const executionStart = new Date();

  const workspaceProvider = getWorkspaceProvider();
  if (!workspaceProvider) {
    logger.warn({ agentId }, 'Deep research: no workspace provider, falling back to fast path');
    return executeFast({ ...input, needsDeepResearch: false });
  }

  // Resolve which repo to clone — use the first project in the org
  const projects = await (await import('../adapters/registry.js')).getProjectRegistry().listProjects(orgId);
  if (projects.length === 0) {
    logger.warn({ agentId }, 'Deep research: no projects, falling back to fast path');
    return executeFast({ ...input, needsDeepResearch: false });
  }

  // Find a project with a repoKey
  let repoKey: string | null = null;
  for (const p of projects) {
    if (p.repoKey) { repoKey = p.repoKey; break; }
    const rk = await (await import('../adapters/registry.js')).getProjectRegistry().resolveRepoKey(p.id, orgId);
    if (rk) { repoKey = rk; break; }
  }

  if (!repoKey) {
    logger.warn({ agentId }, 'Deep research: no repoKey found, falling back to fast path');
    return executeFast({ ...input, needsDeepResearch: false });
  }

  let workspace: import('../adapters/interfaces/workspace-provider.js').WorkspaceHandle | null = null;
  try {
    workspace = await workspaceProvider.acquireWorkspace(orgId, repoKey);
    logger.info({ agentId, repoPath: workspace.repoPath }, 'Deep research: workspace acquired');

    // Dynamically import deep research tools
    const { DEEP_TOOL_DECLARATIONS, executeDeepTool } = await import('../workspace/tools.js');

    const systemPrompt = await buildAgentPrompt(agentId, channelId, orgId, { hasCodeTools: true });
    const deepSystemPrompt = systemPrompt + '\n\n---\n\n# Deep Research Mode\nYou have access to a cloned copy of the repository with git tools. Take your time to thoroughly investigate the codebase. You can use git blame, git log, git diff, and other tools to trace code history and understand changes.';

    let fullUserMessage = userMessage;
    if (steering) {
      fullUserMessage = `USER FEEDBACK: "${steering.userFeedback}"\nPREVIOUS PROPOSAL: "${steering.previousProposal}"\nPlease refine based on this feedback.`;
    }

    const contents: LLMContent[] = [{ role: 'user', parts: [{ text: fullUserMessage }] }];
    const startTime = Date.now();

    for (let round = 0; round < DEEP_RESEARCH_MAX_TURNS; round++) {
      if (Date.now() - startTime > DEEP_RESEARCH_TIMEOUT_MS) {
        logger.warn({ agentId, round }, 'Deep research: timeout reached');
        break;
      }

      const result = await getLLMProvider().generateWithTools({
        model: 'WORK',
        orgId,
        systemInstruction: deepSystemPrompt,
        contents,
        tools: DEEP_TOOL_DECLARATIONS,
      });

      if (result.functionCalls.length === 0) {
        // Final text response
        const response = result.text ?? '';
        logger.info({ agentId, rounds: round + 1 }, 'Deep research: complete');
        return await processDeepResearchResult(input, response, executionStart);
      }

      logger.info({ round, toolCalls: result.functionCalls.map(fc => fc.name) }, 'Deep research tool round');

      // Build model turn with IDs for provider correlation
      const modelParts: LLMContent['parts'] = [];
      if (result.text) modelParts.push({ text: result.text });
      for (const fc of result.functionCalls) {
        const callId = fc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        modelParts.push({ functionCall: { name: fc.name, args: fc.args, id: callId } });
      }
      contents.push({ role: 'model', parts: modelParts });

      // Execute tools against workspace
      const responseParts: LLMContent['parts'] = [];
      for (let i = 0; i < result.functionCalls.length; i++) {
        const fc = result.functionCalls[i];
        const callId = (modelParts.find(p => p.functionCall?.name === fc.name) as any)?.functionCall?.id ?? fc.id;
        const toolResult = await executeDeepTool(fc.name, fc.args, workspace.repoPath);
        responseParts.push({
          functionResponse: { name: fc.name, response: { result: toolResult }, id: callId },
        });
      }
      contents.push({ role: 'user', parts: responseParts });
    }

    // Exhausted turns — force summary
    contents.push({ role: 'user', parts: [{ text: 'You have used all available research rounds. Provide your final analysis and conclusions now.' }] });
    const finalResponse = await getLLMProvider().generateText({
      model: 'WORK',
      orgId,
      systemInstruction: deepSystemPrompt,
      contents,
    });
    return await processDeepResearchResult(input, finalResponse, executionStart);
  } catch (err) {
    logger.error({ err, agentId }, 'Deep research failed');
    // Fall back to fast path
    return executeFast({ ...input, needsDeepResearch: false });
  } finally {
    if (workspace) {
      await workspace.cleanup().catch(err => logger.error({ err }, 'Workspace cleanup failed'));
    }
  }
}

async function checkPendingActions(input: ExecuteAgentInput, executionStart: Date) {
  const { orgId, agentId, onActionQueued } = input;

  // Find actions created during this execution that are awaiting nexus_review
  const newActions = await db
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        eq(pendingActions.agentId, agentId),
        eq(pendingActions.status, 'nexus_review'),
        isNull(pendingActions.resolvedAt),
        gte(pendingActions.createdAt, executionStart),
      ),
    );

  for (const action of newActions) {
    logger.info({ actionId: action.id, agentId }, 'New proposal awaiting Nexus review');

    if (onActionQueued) {
      try {
        await onActionQueued(action.id, action.description);
      } catch (err) {
        logger.error({ err, actionId: action.id, agentId }, 'onActionQueued callback failed');
      }
    }
  }
}

async function agentCreatedProposalsSince(agentId: string, orgId: string, since: Date): Promise<number> {
  const recent = await db
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        eq(pendingActions.agentId, agentId),
        gte(pendingActions.createdAt, since),
      ),
    );
  return recent.length;
}

function suppressProposalDetails(agentId: string, response: string, proposalCount: number): string {
  if (proposalCount === 0) return response;

  // If the agent already narrated their proposal, they don't need to do it again in the final response
  // We want to avoid "I've created a ticket..." if the system is about to announce it anyway.
  if (proposalCount > 0) {
    logger.info({ agentId, proposalCount }, 'Suppressing redundant proposal narration');
    return response; 
  }

  return response;
}
