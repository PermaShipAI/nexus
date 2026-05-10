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
}

/**
 * Patterns that indicate raw chat/Discord transcript dumps rather than synthesized context.
 * These are intentionally narrow to catch the most common transcript formats without
 * producing false positives on legitimate technical prose.
 */
const TRANSCRIPT_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  // Discord/Slack agent prefix format: [AgentName]: message
  { pattern: /(\[[\w\s]+\]:\s*.+\n){2,}/m, name: 'repeated_agent_prefix_lines' },
  // Timestamp-prefixed chat lines: 12:34 AgentName: message or HH:MM:SS AgentName:
  { pattern: /(\d{1,2}:\d{2}(?::\d{2})?\s+[\w\s]+:\s*.+\n){2,}/m, name: 'timestamp_chat_lines' },
  // Username prefix lines: @username: or Username: repeated 3+ times
  { pattern: /(@[\w.-]+:\s*.+\n){3,}/m, name: 'mention_prefix_lines' },
  // Raw "Agent said:" log lines repeated
  { pattern: /(\w+\s+said:\s*.+\n){3,}/m, name: 'said_log_lines' },
];

/** Hard character limit for agentDiscussionContext to force LLM summarisation. */
const MAX_DISCUSSION_CONTEXT_CHARS = 1500;

/** Hard character limit for description to prevent runaway token bloat. */
const MAX_DESCRIPTION_CHARS = 2000;

/** Threshold below which iteration_budget is injected (0–1 scale). */
const LOW_CONFIDENCE_THRESHOLD = 0.4;

/**
 * Detect whether a string appears to be a raw chat/Discord transcript.
 * Returns the list of matched pattern names (empty array = clean).
 */
export function detectTranscriptPatterns(text: string): string[] {
  const matched: string[] = [];
  for (const { pattern, name } of TRANSCRIPT_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(name);
    }
  }
  return matched;
}

/**
 * Heuristically score structural confidence of a proposal (0–1).
 * Lower scores indicate ambiguous or underspecified context that benefits
 * from a capped iteration budget to prevent runaway orchestrator loops.
 *
 * Scoring factors (each deducts from 1.0):
 *   -0.25 if agentDiscussionContext is absent or very short (<100 chars)
 *   -0.25 if description is very short (<80 chars)
 *   -0.25 if title is generic (no file path, ticket ID, or technical noun)
 *   -0.25 if fallbackPlan is absent
 */
export function scoreProposalConfidence(input: Pick<TicketProposalInput, 'title' | 'description' | 'agentDiscussionContext' | 'fallbackPlan'>): number {
  let score = 1.0;

  if (!input.agentDiscussionContext || input.agentDiscussionContext.trim().length < 100) {
    score -= 0.25;
  }
  if (input.description.trim().length < 80) {
    score -= 0.25;
  }
  // Check for at least one technical signal: file path, version, ID, acronym, code reference
  const technicalSignalPattern = /(?:src\/|\.ts|\.js|\.py|v\d+\.\d+|\bAPI\b|\bCVE-|\bID:\s*\w|\b[A-Z]{2,}-\d+\b|`[^`]+`)/;
  if (!technicalSignalPattern.test(input.title) && !technicalSignalPattern.test(input.description)) {
    score -= 0.25;
  }
  if (!input.fallbackPlan) {
    score -= 0.25;
  }

  return Math.max(0, score);
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
 * Create a ticket proposal: resolves project, checks duplicates, inserts into pendingActions.
 * Shared by both CLI path and fast path (structured output).
 */
export async function createTicketProposal(input: TicketProposalInput): Promise<TicketProposalResult> {
  const { orgId, kind, title, description, project, priority, agentId, source, channelId, agentDiscussionContext, fallbackPlan } = input;
  let { repoKey } = input;

  // --- Transcript detection: reject raw chat/Discord transcript dumps ---
  // Raw transcripts cause massive token bloat for downstream planning subagents.
  // The LLM must synthesize a concise technical summary instead.
  const contextsToCheck = [
    { field: 'agentDiscussionContext', value: agentDiscussionContext },
    { field: 'description', value: description },
  ];
  for (const { field, value } of contextsToCheck) {
    if (!value) continue;
    const matched = detectTranscriptPatterns(value);
    if (matched.length > 0) {
      logGuardrailEvent({ event: 'ticket_proposal_transcript_rejected_total', orgId, agentId, title, detectedPatterns: matched });
      logger.warn({ agentId, orgId, title, field, detectedPatterns: matched }, 'ticket_proposal.transcript_rejected: raw chat transcript detected in proposal field');
      return {
        success: false,
        message: `TRANSCRIPT DUMP REJECTED in field "${field}": Raw chat/Discord transcript detected (patterns: ${matched.join(', ')}). ` +
          'Do NOT paste raw conversation logs. Synthesize a concise technical summary (≤1500 chars) describing: ' +
          '(1) the problem statement, (2) agreed technical approach, (3) key constraints. ' +
          'Resubmit with synthesized prose only.',
      };
    }
  }

  // --- Hard length enforcement on agentDiscussionContext ---
  if (agentDiscussionContext && agentDiscussionContext.length > MAX_DISCUSSION_CONTEXT_CHARS) {
    logger.warn({ agentId, orgId, title, length: agentDiscussionContext.length }, 'ticket_proposal.context_too_long: agentDiscussionContext exceeds limit');
    return {
      success: false,
      message: `agentDiscussionContext exceeds the ${MAX_DISCUSSION_CONTEXT_CHARS}-character limit (got ${agentDiscussionContext.length} chars). ` +
        'Summarize the discussion into a tight technical synthesis and resubmit.',
    };
  }

  // --- Hard length enforcement on description ---
  if (description.length > MAX_DESCRIPTION_CHARS) {
    logger.warn({ agentId, orgId, title, length: description.length }, 'ticket_proposal.description_too_long: description exceeds hard limit');
    return {
      success: false,
      message: `description exceeds the ${MAX_DESCRIPTION_CHARS}-character limit (got ${description.length} chars). ` +
        'Condense the description to focus on the core problem and acceptance criteria.',
    };
  }

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

  // --- Iteration budget injection for low-confidence proposals ---
  // Ambiguous or underspecified proposals risk runaway orchestrator loops.
  // Inject a strict turn cap to bound downstream cost exposure.
  const confidenceScore = scoreProposalConfidence({ title, description, agentDiscussionContext, fallbackPlan });
  let iterationBudget: { max_turns: number } | undefined;
  if (confidenceScore < LOW_CONFIDENCE_THRESHOLD) {
    iterationBudget = { max_turns: 3 };
    logGuardrailEvent({ event: 'ticket_iteration_budget_applied_total', orgId, agentId, title, confidenceScore });
    logger.info({ agentId, orgId, title, confidenceScore }, 'ticket_proposal.iteration_budget_applied: low-confidence proposal capped at 3 turns');
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

  logger.info({ agentId, hasDiscussionContext: !!agentDiscussionContext, hasFallbackPlan: !!fallbackPlan }, 'ticket_proposal.enriched');

  // Store resolved project-id and repo-key in args for the approval flow
  const resolvedArgs = {
    kind,
    title,
    description: fullDescription,
    'project-id': projectId,
    'repo-key': repoKey,
    project,
    ...(priority !== undefined ? { priority: String(priority) } : {}),
    ...(iterationBudget !== undefined ? { iteration_budget: iterationBudget } : {}),
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
