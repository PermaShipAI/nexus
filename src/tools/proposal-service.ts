import { db } from '../db/index.js';
import { pendingActions, tickets as ticketsTable } from '../db/schema.js';
import { eq, desc, and, gte, ne } from 'drizzle-orm';
import { getProjectRegistry } from '../adapters/registry.js';
import { getCommitProvider } from '../adapters/registry.js';
import { getLLMProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';
import type { AgentId } from '../agents/types.js';
import { parseArgs } from '../utils/parse-args.js';
import { onProposalCreated } from '../nexus/scheduler.js';
import { logCrossAgentConflictResolved } from '../telemetry/cross-agent.js';
import { logGuardrailEvent } from '../telemetry/index.js';

export interface TicketProposalInput {
  orgId: string;
  kind: 'bug' | 'feature' | 'task';
  title: string;
  description: string;
  project: string;
  repoKey?: string;
  priority?: number;
  agentId: AgentId;
  /** Origin of this proposal: 'user' for Slack/Discord messages, 'idle' for system-initiated */
  source?: 'user' | 'idle';
  /** Channel where this proposal originated (mission channel for mission-scoped autonomous mode) */
  channelId?: string;
  /** Synthesized prose summary of agent discussion context (max 1500 chars). */
  agentDiscussionContext?: string;
  /** Fallback plan for non-primary execution paths. Must begin with "**Fallback:**". */
  fallbackPlan?: string;
  /** How the success of this ticket will be measured. Required for all proposals. */
  measurementPlan: string;
  /** Conditions under which this work should be stopped or rolled back. Required for all proposals. */
  stopConditions: string;
  /** References to knowledge base articles or documentation relevant to this ticket. */
  knowledgeBaseReferences?: string;
  /** Reviewer handles or agent IDs that must review this ticket before merge. */
  requiredReviewers?: string;
}

export interface TicketProposalResult {
  success: boolean;
  actionId?: string;
  duplicate?: boolean;
  matchedTitle?: string;
  message: string;
}

export interface DuplicateCheckResult {
  matchedTitle: string;
  actionId?: string;
  conflictType: 'DUPLICATE' | 'ROOT_CAUSE_OVERLAP';
}

/**
 * Use the LLM provider to check if a proposed ticket is a duplicate or root-cause overlap of recent tickets (last 24h).
 * Returns a DuplicateCheckResult if a conflict is detected, null if the ticket is novel.
 */
export async function checkDuplicateTicket(title: string, description: string, orgId: string): Promise<DuplicateCheckResult | null> {
  // Only check very recent proposals (last 2 hours, not 24h).
  // Older proposals that led to failed tickets shouldn't block new sub-task attempts.
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000);

  // Gather recent pending actions (tickets proposed in last 24h)
  // Exclude rejected proposals AND proposals whose tickets failed execution
  // (failed tickets shouldn't block new sub-task proposals)
  const allActions = await db
    .select({ id: pendingActions.id, args: pendingActions.args, status: pendingActions.status, agentId: pendingActions.agentId })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        eq(pendingActions.command, 'create-ticket'),
        ne(pendingActions.status, 'rejected'),
        gte(pendingActions.createdAt, since),
      ),
    )
    .orderBy(desc(pendingActions.createdAt))
    .limit(30);

  // Cross-reference with tickets to exclude proposals that led to failed executions
  const failedTicketTitles = new Set(
    (await db.select({ title: ticketsTable.title }).from(ticketsTable).where(
      and(eq(ticketsTable.orgId, orgId)),
    ).limit(50))
      .filter(() => false) // will populate below
      .map(t => t.title.toLowerCase()),
  );
  const failedTickets = await db.select({ title: ticketsTable.title, executionStatus: ticketsTable.executionStatus })
    .from(ticketsTable).where(eq(ticketsTable.orgId, orgId)).limit(50);
  for (const t of failedTickets) {
    if (t.executionStatus === 'failed' || t.executionStatus === 'review_failed') {
      failedTicketTitles.add(t.title.toLowerCase());
    }
  }

  const actions = allActions.filter(a => {
    const args = parseArgs(a.args);
    const actionTitle = ((args.title as string) ?? '').toLowerCase();
    return !failedTicketTitles.has(actionTitle);
  });

  // Gather recently created tickets — exclude failed ones so that broken-down
  // sub-tasks from a failed monolithic ticket aren't blocked by the original
  const recentTickets = await db
    .select({ title: ticketsTable.title, kind: ticketsTable.kind, description: ticketsTable.description, executionStatus: ticketsTable.executionStatus })
    .from(ticketsTable)
    .where(and(eq(ticketsTable.orgId, orgId), gte(ticketsTable.createdAt, since)))
    .orderBy(desc(ticketsTable.createdAt))
    .limit(30);

  // Filter out failed tickets — they shouldn't block new attempts
  const activeTickets = recentTickets.filter(t =>
    t.executionStatus !== 'failed' && t.executionStatus !== 'review_failed'
  );

  // Build indexed list of existing tickets for the AI to review (1-based index for AI response)
  type ExistingEntry = { label: string; title: string; actionId?: string };
  const existingEntries: ExistingEntry[] = [];

  for (const action of actions) {
    const args = parseArgs(action.args);
    const actionTitle = (args.title as string) ?? '';
    existingEntries.push({
      label: `[${action.status}] "${actionTitle}" (${args.kind ?? 'unknown'}) by ${action.agentId}: ${((args.description as string) ?? '').slice(0, 200)}`,
      title: actionTitle,
      actionId: action.id,
    });
  }

  for (const ticket of activeTickets) {
    existingEntries.push({
      label: `[created] "${ticket.title}" (${ticket.kind}): ${ticket.description.slice(0, 200)}`,
      title: ticket.title,
    });
  }

  // If no recent tickets exist, nothing to compare against
  if (existingEntries.length === 0) return null;

  const existingLines = existingEntries.map((e, i) => `${i + 1}. ${e.label}`).join('\n');

  const prompt = `You are a duplicate ticket detector. Compare a PROPOSED ticket against EXISTING tickets from the last 24 hours.

EXISTING TICKETS:
${existingLines}

PROPOSED TICKET:
Title: "${title}"
Description: "${description.slice(0, 500)}"

Classify the proposed ticket as one of:
- DUPLICATE: Same underlying issue or scope as an existing ticket, even if worded differently.
- ROOT_CAUSE_OVERLAP: A different task than existing tickets but targeting the same underlying component, file, or root cause. Concurrent execution would produce conflicting or redundant changes to the same codebase surface area (e.g. a security patch and a performance refactor both modifying the same file).
- NOVEL: Genuinely different scope from all existing tickets.

Respond with EXACTLY one line:
- If DUPLICATE: DUPLICATE:<index> "<title of the matching existing ticket>"
- If ROOT_CAUSE_OVERLAP: ROOT_CAUSE_OVERLAP:<index> "<title of the matching existing ticket>"
- If novel: NOVEL

Where <index> is the 1-based index number from the EXISTING TICKETS list.`;

  try {
    const response = await getLLMProvider().generateText({
      model: 'ROUTER',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const trimmed = response.trim();

    const duplicateMatch = trimmed.match(/^DUPLICATE:(\d+)\s+"?(.+?)"?\s*$/);
    if (duplicateMatch) {
      const idx = parseInt(duplicateMatch[1], 10) - 1;
      const entry = existingEntries[idx];
      return {
        matchedTitle: entry?.title ?? duplicateMatch[2],
        actionId: entry?.actionId,
        conflictType: 'DUPLICATE',
      };
    }

    const overlapMatch = trimmed.match(/^ROOT_CAUSE_OVERLAP:(\d+)\s+"?(.+?)"?\s*$/);
    if (overlapMatch) {
      const idx = parseInt(overlapMatch[1], 10) - 1;
      const entry = existingEntries[idx];
      return {
        matchedTitle: entry?.title ?? overlapMatch[2],
        actionId: entry?.actionId,
        conflictType: 'ROOT_CAUSE_OVERLAP',
      };
    }

    return null;
  } catch {
    // If the AI check fails, allow the ticket through rather than blocking
    return null;
  }
}

/**
 * Validate that a ticket proposal meets the Nexus Definition of Done (DoD) preflight schema.
 * Returns an error message string if validation fails, or null if the proposal is valid.
 * Emits agent_tool_schema_rejection_nexus_dod telemetry on failure.
 */
function validateNexusDoD(input: TicketProposalInput): string | null {
  const missingFields: string[] = [];

  if (!input.measurementPlan || typeof input.measurementPlan !== 'string' || input.measurementPlan.trim().length === 0) {
    missingFields.push('measurementPlan');
  }
  if (!input.stopConditions || typeof input.stopConditions !== 'string' || input.stopConditions.trim().length === 0) {
    missingFields.push('stopConditions');
  }

  if (missingFields.length === 0) return null;

  logGuardrailEvent({
    event: 'agent_tool_schema_rejection_nexus_dod',
    orgId: input.orgId,
    agentId: input.agentId,
    title: input.title,
    missingFields,
  });

  const fieldExamples: Record<string, string> = {
    measurementPlan: 'e.g. "P95 latency drops below 200ms on the /api/search endpoint as measured by Datadog over a 1h window post-deploy"',
    stopConditions: 'e.g. "Roll back if error rate exceeds 1% or if any smoke test fails in staging"',
  };

  const fieldDescriptions = missingFields
    .map(f => `- **${f}**: ${fieldExamples[f] ?? 'a non-empty string is required'}`)
    .join('\n');

  return `NEXUS DOD SCHEMA REJECTION: The following required fields are missing or empty:\n${fieldDescriptions}\n\nAdd these fields to your ticket proposal and resubmit. Every proposal must include measurable success criteria and explicit stop conditions.`;
}

/**
 * Create a ticket proposal: resolves project, checks duplicates, inserts into pendingActions.
 * Shared by both CLI path and fast path (structured output).
 */
export async function createTicketProposal(input: TicketProposalInput): Promise<TicketProposalResult> {
  const { orgId, kind, title, description, project, priority, agentId, source, channelId, agentDiscussionContext, fallbackPlan, measurementPlan, stopConditions, knowledgeBaseReferences, requiredReviewers } = input;
  let { repoKey } = input;

  // Enforce fallback plan for idle-sourced (agentops/system-initiated) proposals.
  // Human-facing guardrail: downstream subagents must not attempt primary and fallback
  // paths simultaneously. Reject idle proposals that omit a fallbackPlan entirely.
  if (source === 'idle' && !fallbackPlan) {
    logGuardrailEvent({ event: 'agentops_fallback_missing', orgId, agentId, title });
    logger.warn({ agentId, orgId, title }, 'agentops_fallback_missing: idle proposal rejected — fallbackPlan is required');
    return {
      success: false,
      message: 'Idle proposals must include a fallbackPlan. Add a "**Fallback:**" section describing the alternative execution path.',
    };
  }

  // Nexus DoD preflight validation — fires before duplicate detection to fail fast
  const dodError = validateNexusDoD(input);
  if (dodError) {
    logger.warn({ agentId, orgId, title }, 'nexus_dod_schema_rejection: proposal rejected — measurementPlan or stopConditions missing');
    return {
      success: false,
      message: dodError,
    };
  }

  // Compose enriched description from base description + optional sections
  let fullDescription = description;
  if (agentDiscussionContext) {
    fullDescription += `\n\n## Agent Discussion Context\n${agentDiscussionContext}`;
  }
  if (fallbackPlan) {
    const normalizedFallback = fallbackPlan.startsWith('**Fallback:**') ? fallbackPlan : `**Fallback:** ${fallbackPlan}`;
    fullDescription += `\n\n## Fallback Plan\n${normalizedFallback}`;
  }
  if (measurementPlan) {
    fullDescription += `\n\n## Measurement Plan\n${measurementPlan}`;
  }
  if (stopConditions) {
    fullDescription += `\n\n## Stop Conditions\n${stopConditions}`;
  }
  if (knowledgeBaseReferences) {
    fullDescription += `\n\n## Knowledge Base References\n${knowledgeBaseReferences}`;
  }
  if (requiredReviewers) {
    fullDescription += `\n\n## Required Reviewers\n${requiredReviewers}`;
  }

  if (fullDescription.length > 4000) {
    logger.warn({ agentId, descriptionLength: fullDescription.length }, 'ticket_proposal.description_too_long: fullDescription exceeds 4000 chars');
  }

  // Resolve project name to UUID
  const projectId = await getProjectRegistry().resolveProjectId(project, orgId);
  if (!projectId) {
    const available = await getProjectRegistry().listProjects(orgId);
    const names = available.map(p => `"${p.name}"`).join(', ');
    return {
      success: false,
      message: `Could not resolve project "${project}". Available projects: ${names || 'none found'}. Use an EXACT project name from this list.`,
    };
  }

  // Resolve repoKey from project configuration, fall back to slug
  if (!repoKey) {
    const apiRepoKey = await getProjectRegistry().resolveRepoKey(projectId, orgId);
    if (apiRepoKey) {
      repoKey = apiRepoKey;
    } else {
      const slug = await getProjectRegistry().resolveProjectSlug(projectId, orgId);
      repoKey = slug ?? 'unknown';
    }
  }

  // AI-based deduplication — skip for idle/mission-sourced proposals since the
  // heartbeat system already manages what items need tickets. The AI duplicate
  // checker was rejecting valid sub-task proposals as overlapping with failed
  // parent tickets, blocking all mission progress.
  const conflictResult = source === 'idle' ? null : await checkDuplicateTicket(title, fullDescription, orgId);
  if (conflictResult) {
    logCrossAgentConflictResolved({
      orgId,
      proposingAgentId: agentId,
      newTitle: title,
      matchedTitle: conflictResult.matchedTitle,
    });
    if (conflictResult.conflictType === 'ROOT_CAUSE_OVERLAP') {
      logger.warn({
        event: 'cross_agent_conflict_rejected',
        agentId,
        proposedTitle: title,
        matchedTitle: conflictResult.matchedTitle,
        existingProposalId: conflictResult.actionId,
      }, 'cross_agent_conflict_rejected');
      const idClause = conflictResult.actionId ? ` (proposal ID: ${conflictResult.actionId})` : '';
      return {
        success: false,
        duplicate: true,
        matchedTitle: conflictResult.matchedTitle,
        message: `CROSS-AGENT CONFLICT REJECTED: This proposal targets the same underlying component or root cause as an existing proposal: "${conflictResult.matchedTitle}"${idClause}. Do NOT create a separate ticket. Instead, retrieve that proposal and merge your Acceptance Criteria into it to consolidate the work under a single execution context.`,
      };
    }
    return {
      success: false,
      duplicate: true,
      matchedTitle: conflictResult.matchedTitle,
      message: `DUPLICATE REJECTED: An AI review determined this ticket overlaps with an existing one: "${conflictResult.matchedTitle}". Do NOT re-propose tickets that have already been proposed or created.`,
    };
  }

  logger.info({ agentId, hasDiscussionContext: !!agentDiscussionContext, hasFallbackPlan: !!fallbackPlan, hasMeasurementPlan: !!measurementPlan, hasStopConditions: !!stopConditions }, 'ticket_proposal.enriched');

  // Store resolved project-id and repo-key in args for the approval flow
  const resolvedArgs = {
    kind,
    title,
    description: fullDescription,
    'project-id': projectId,
    'repo-key': repoKey,
    project,
    ...(priority !== undefined ? { priority: String(priority) } : {}),
  };

  // CTO proposals go directly to human review; all others need CTO gate first
  const status = agentId === 'nexus' ? 'pending' : 'nexus_review';

  // Build file context for staleness tracking (best-effort)
  let fileContext: { repoKey: string; filePaths: string[]; commitSha?: string } | undefined;
  if (repoKey) {
    // Extract file paths mentioned in the description
    const filePathRegex = /(?:^|\s)((?:src|lib|app|packages|tests?)\/[\w./-]+)/g;
    const filePaths: string[] = [];
    let fpMatch: RegExpExecArray | null;
    while ((fpMatch = filePathRegex.exec(fullDescription)) !== null) {
      filePaths.push(fpMatch[1]);
    }

    const latestCommit = await getCommitProvider().fetchLatestCommit(orgId, repoKey).catch(() => null);
    fileContext = {
      repoKey,
      filePaths,
      commitSha: latestCommit?.sha,
    };
  }

  const [pending] = await db.insert(pendingActions).values({
    orgId,
    agentId,
    command: 'create-ticket',
    args: resolvedArgs,
    description: `Create ${kind} ticket: "${title}"`,
    status,
    source: source ?? null,
    channelId: channelId ?? null,
    fileContext: fileContext ?? null,
  }).returning();

  const statusMessage = status === 'pending'
    ? `Ticket proposal "${title}" queued for human approval.`
    : `Ticket proposal "${title}" submitted for Nexus review. Do NOT announce this to Discord — Nexus will handle it.`;

  logger.info({ agentId, actionId: pending.id, title, kind, status }, 'Ticket proposal created');

  // Notify Nexus scheduler that a new proposal exists (unless it already skipped Nexus review)
  if (status === 'nexus_review') {
    onProposalCreated(orgId);
  }


  return {
    success: true,
    actionId: pending.id,
    message: statusMessage,
  };
}
