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
  /** Synthesized prose summary of agent discussion context (max 1500 chars). */
  agentDiscussionContext?: string;
  /** Fallback plan for non-primary execution paths. Must begin with "**Fallback:**". */
  fallbackPlan?: string;
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
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Gather recent pending actions (tickets proposed in last 24h, any status except rejected)
  const actions = await db
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

  // Gather recently created tickets
  const recentTickets = await db
    .select({ title: ticketsTable.title, kind: ticketsTable.kind, description: ticketsTable.description })
    .from(ticketsTable)
    .where(and(eq(ticketsTable.orgId, orgId), gte(ticketsTable.createdAt, since)))
    .orderBy(desc(ticketsTable.createdAt))
    .limit(30);

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

  for (const ticket of recentTickets) {
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
  const { orgId, kind, title, description, project, priority, agentId, source, agentDiscussionContext, fallbackPlan } = input;
  let { repoKey } = input;

  // Compose enriched description from base description + optional sections
  let fullDescription = description;
  if (agentDiscussionContext) {
    fullDescription += `\n\n## Agent Discussion Context\n${agentDiscussionContext}`;
  }
  if (fallbackPlan) {
    const normalizedFallback = fallbackPlan.startsWith('**Fallback:**') ? fallbackPlan : `**Fallback:** ${fallbackPlan}`;
    fullDescription += `\n\n## Fallback Plan\n${normalizedFallback}`;
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

  // AI-based deduplication (exact duplicate and root-cause/component overlap)
  const conflictResult = await checkDuplicateTicket(title, fullDescription, orgId);
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
