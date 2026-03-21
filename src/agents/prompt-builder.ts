import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgent } from './registry.js';
import { getRecentMessages } from '../conversation/service.js';
import { listTasks } from '../tasks/service.js';
import { getAgentMemories, getSharedKnowledge } from '../knowledge/service.js';
import { db } from '../db/index.js';
import { pendingActions, tickets as ticketsTable, tasks, activityLog } from '../db/schema.js';
import { eq, desc, ne, and, gte, inArray } from 'drizzle-orm';
import type { AgentId } from './types.js';
import { getProjectRegistry, getTenantResolver } from '../adapters/registry.js';

import { tmpdir } from 'node:os';
import { getMissionByChannelId, getMissionItems, getMissionProjects } from '../missions/service.js';

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ?? (process.env.NODE_ENV === 'production' ? '/app' : process.cwd());

/**
 * Get tickets recently proposed or created by a specific agent (last 48h) for a specific org.
 */
async function getAgentTicketHistory(agentId: AgentId, orgId: string): Promise<string | null> {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const agentActions = await db
    .select({ args: pendingActions.args, status: pendingActions.status, createdAt: pendingActions.createdAt })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        eq(pendingActions.agentId, agentId),
        eq(pendingActions.command, 'create-ticket'),
        gte(pendingActions.createdAt, since),
      ),
    )
    .orderBy(desc(pendingActions.createdAt))
    .limit(20);

  const agentTickets = await db
    .select({ title: ticketsTable.title, kind: ticketsTable.kind, createdAt: ticketsTable.createdAt })
    .from(ticketsTable)
    .where(
      and(
        eq(ticketsTable.orgId, orgId),
        eq(ticketsTable.createdByAgentId, agentId),
        gte(ticketsTable.createdAt, since),
      ),
    )
    .orderBy(desc(ticketsTable.createdAt))
    .limit(20);

  const lines: string[] = [];

  for (const a of agentActions) {
    const args = a.args as Record<string, unknown>;
    const ago = Math.round((Date.now() - a.createdAt.getTime()) / 3600000);
    lines.push(`- [${a.status}] "${args.title}" (${args.kind ?? 'ticket'}) — ${ago}h ago`);
  }

  for (const t of agentTickets) {
    const ago = Math.round((Date.now() - t.createdAt.getTime()) / 3600000);
    lines.push(`- [created] "${t.title}" (${t.kind}) — ${ago}h ago`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

async function getTicketActivityText(orgId: string): Promise<{ pending: string | null; ctoReview: string | null; existing: string | null }> {
  // Pending actions awaiting human approval in Discord
  const pending = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.orgId, orgId), eq(pendingActions.status, 'pending')))
    .orderBy(desc(pendingActions.createdAt))
    .limit(20);

  // Proposals awaiting Nexus review
  const ctoReview = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.orgId, orgId), eq(pendingActions.status, 'nexus_review')))
    .orderBy(desc(pendingActions.createdAt))
    .limit(20);

  // Recently approved/processed actions (to prevent duplicates)
  const processed = await db
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        ne(pendingActions.status, 'pending'),
        ne(pendingActions.status, 'nexus_review'),
      ),
    )
    .orderBy(desc(pendingActions.createdAt))
    .limit(30);

  // Tickets that were actually created
  const createdTickets = await db
    .select()
    .from(ticketsTable)
    .where(eq(ticketsTable.orgId, orgId))
    .orderBy(desc(ticketsTable.createdAt))
    .limit(30);

  const pendingText = pending.length > 0
    ? pending.map((a) => {
        const args = a.args as Record<string, unknown>;
        return `- [PENDING HUMAN REVIEW] [${a.agentId}] ${a.description} (project: ${args.project ?? args['project-id'] ?? 'unknown'})`;
      }).join('\n')
    : null;

  const ctoReviewText = ctoReview.length > 0
    ? ctoReview.map((a) => {
        const args = a.args as Record<string, unknown>;
        return `- [AWAITING NEXUS REVIEW] [${a.agentId}] ${a.description} (project: ${args.project ?? args['project-id'] ?? 'unknown'})`;
      }).join('\n')
    : null;

  const existingLines: string[] = [];

  for (const a of processed) {
    const args = a.args as Record<string, unknown>;
    existingLines.push(`- [${a.status.toUpperCase()}] [${a.agentId}] ${a.description} (project: ${args.project ?? args['project-id'] ?? 'unknown'})`);
  }

  for (const t of createdTickets) {
    existingLines.push(`- [CREATED] [${t.createdByAgentId ?? 'unknown'}] ${t.kind}: "${t.title}" (repo: ${t.repoKey})`);
  }

  return {
    pending: pendingText,
    ctoReview: ctoReviewText,
    existing: existingLines.length > 0 ? existingLines.join('\n') : null,
  };
}

/**
 * Build CTO-specific context sections: full proposal queue, portfolio overview,
 * recent decisions, and agent activity summary.
 */
async function buildNexusContext(orgId: string): Promise<string[]> {
  const sections: string[] = [];

  // 1. Nexus Review Queue — proposals awaiting CTO decision
  const ctoReviewQueue = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.orgId, orgId), eq(pendingActions.status, 'nexus_review')))
    .orderBy(desc(pendingActions.createdAt))
    .limit(50);

  if (ctoReviewQueue.length > 0) {
    const lines = ctoReviewQueue.map((a) => {
      const argsJson = JSON.stringify(a.args, null, 2);
      return `- **[${a.agentId}]** (ID: \`${a.id}\`) ${a.command}: ${a.description}\n  Args: \`\`\`json\n${argsJson}\n\`\`\``;
    });
    sections.push(`# Nexus Review Queue (Awaiting Your Decision)\nUse \`<approve-proposal>{"id":"<ID>","reason":"..."}</approve-proposal>\` or \`<reject-proposal>{"id":"<ID>","reason":"..."}</reject-proposal>\` for each.\n${lines.join('\n')}`);
  } else {
    sections.push(`# Nexus Review Queue\nNo proposals awaiting your review.`);
  }

  // 1b. Recently promoted proposals (approved by CTO, now awaiting human review)
  const oneDayAgoForPromoted = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentlyPromoted = await db
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        eq(pendingActions.status, 'pending'),
        gte(pendingActions.createdAt, oneDayAgoForPromoted),
      ),
    )
    .orderBy(desc(pendingActions.createdAt))
    .limit(20);

  if (recentlyPromoted.length > 0) {
    const lines = recentlyPromoted.map((a) => {
      const args = a.args as Record<string, unknown>;
      return `- **[${a.agentId}]** "${args.title}" — awaiting human approval in Discord`;
    });
    sections.push(`# Recently Approved by Nexus (Now in Human Review)\n${lines.join('\n')}`);
  }

  // 2. Portfolio Overview — all active tasks grouped by status with relationships
  const activeTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.orgId, orgId), inArray(tasks.status, ['proposed', 'approved', 'in_progress'])))
    .orderBy(desc(tasks.priority), desc(tasks.createdAt))
    .limit(50);

  if (activeTasks.length > 0) {
    const lines = activeTasks.map((t) => {
      const parts = [`[${t.status}] [${t.priority}] ${t.title} → ${t.assignedAgentId ?? 'unassigned'}`];
      if (t.strategyId) parts.push(`strategy: ${t.strategyId}`);
      if (t.parentTaskId) parts.push(`parent: ${t.parentTaskId}`);
      return `- ${parts.join(' | ')}`;
    });
    sections.push(`# Portfolio Overview (Active Tasks)\n${lines.join('\n')}`);
  }

  // 3. Recent Decisions — resolved pending actions from last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentDecisions = await db
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.orgId, orgId),
        ne(pendingActions.status, 'pending'),
        gte(pendingActions.createdAt, sevenDaysAgo),
      ),
    )
    .orderBy(desc(pendingActions.resolvedAt))
    .limit(30);

  if (recentDecisions.length > 0) {
    const lines = recentDecisions.map((a) => {
      const resolved = a.resolvedAt ? ` — resolved ${a.resolvedAt.toISOString().slice(0, 10)}` : '';
      return `- [${a.status.toUpperCase()}] [${a.agentId}] ${a.description}${resolved}`;
    });
    sections.push(`# Recent Decisions (Last 7 Days)\n${lines.join('\n')}`);
  }

  // 4. Agent Activity Summary — which agents were active in last 24h
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentActivity = await db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.orgId, orgId), gte(activityLog.createdAt, oneDayAgo)))
    .orderBy(desc(activityLog.createdAt))
    .limit(50);

  if (recentActivity.length > 0) {
    const byAgent = new Map<string, string[]>();
    for (const entry of recentActivity) {
      const key = entry.agentId ?? 'system';
      if (!byAgent.has(key)) byAgent.set(key, []);
      byAgent.get(key)!.push(`${entry.kind} (${entry.createdAt.toISOString().slice(11, 16)})`);
    }
    const lines = Array.from(byAgent.entries()).map(
      ([agent, actions]) => `- **${agent}**: ${actions.join(', ')}`,
    );
    sections.push(`# Agent Activity Summary (Last 24h)\n${lines.join('\n')}`);
  }

  return sections;
}

/**
 * Build mission-specific context sections when the channel is a mission channel.
 * Returns null if this is not a mission channel.
 */
async function buildMissionContext(channelId: string, _orgId: string): Promise<string[] | null> {
  if (!channelId.startsWith('mission:')) return null;

  const mission = await getMissionByChannelId(channelId);
  if (!mission) return null;

  const sections: string[] = [];
  const items = await getMissionItems(mission.id);
  const projects = await getMissionProjects(mission.id);

  // Mission overview
  sections.push(`# Active Mission: ${mission.title}\n**Status:** ${mission.status}\n**Goal:** ${mission.description}`);

  // Checklist
  if (items.length > 0) {
    const checklist = items.map((i) => {
      const marker =
        i.status === 'verified' ? '[x]' :
        i.status === 'agent_complete' ? '[?]' :
        i.status === 'in_progress' ? '[~]' : '[ ]';
      const assignee = i.assignedAgentId ? ` (assigned: ${i.assignedAgentId})` : '';
      return `${marker} **${i.title}**${assignee}\n    ${i.description}`;
    }).join('\n');
    sections.push(`# Mission Checklist\n${checklist}`);
  }

  // Project scope
  if (projects.length > 0) {
    const projectList = projects.map((p) => `- **${p.name}** (${p.localPath})`).join('\n');
    sections.push(`# Mission Project Scope\n${projectList}`);
  }

  // Mission-specific tools
  sections.push(`# Mission Tools
When you complete a checklist item, declare it:
\`\`\`
<mission-item-complete>{"itemId":"<item-uuid>","summary":"What was done"}</mission-item-complete>
\`\`\`

Nexus can verify or reopen items:
\`\`\`
<mission-verify>{"itemId":"<item-uuid>"}</mission-verify>
<mission-reopen>{"itemId":"<item-uuid>","reason":"What still needs work"}</mission-reopen>
\`\`\``);

  return sections;
}

/** Support-specific instruction section */
function buildSupportInstructions(): string {
  return `# Support Agent Instructions

## Your Primary Role
You are the **customer support intake agent**. Your sole path for user-management actions is \`request-admin-action\`. You NEVER execute user-management commands directly.

## Approved Workflow for User-Management Requests
1. Gather all required information from the user: action type, target user, and reason.
2. Submit the request via \`request-admin-action\` CLI command.
3. Inform the user their request is pending human review.

## FORBIDDEN COMMANDS
You are STRICTLY PROHIBITED from using the following commands under any circumstances:
- \`provision_user\` — FORBIDDEN
- \`delete_user\` — FORBIDDEN
- \`grant_role\` — FORBIDDEN
- \`approve-proposal\` — FORBIDDEN (Nexus only)
- \`reject-proposal\` — FORBIDDEN (Nexus only)
- \`set-secret\` — FORBIDDEN
- \`browse\` — FORBIDDEN

Attempting to use any of these commands is a critical policy violation.

## Tool Usage
- Use \`request-admin-action\` for ALL user-management requests (the only approved path).
- Use \`create-task\` for tracking support work items.
- Use \`add-memory\` to record context about open or recurring requests.
- Use \`query-knowledge\` to look up policies before submitting requests.`;
}

/** CTO-specific instruction section */
function buildNexusInstructions(): string {
  return `# Nexus Director Instructions

## Your Primary Role
You are the **proposal gatekeeper**. All specialist agent proposals land in your Nexus Review Queue before any human sees them. Your primary job is to **process this queue** by approving, rejecting, or requesting refinement.

## Decision-Making Process
You will be given ONE proposal at a time to evaluate. For each proposal, you MUST render a decision using exactly one inline block in your response:
   - **Approve**: Include an \`<approve-proposal>\` block — promotes it to human review (or auto-creates a ticket in autonomous mode).
   - **Reject**: Include a \`<reject-proposal>\` block — kills the proposal with an explanation.
   - **Defer**: Include a \`<defer-proposal>\` block — sends the proposal back with specific, actionable feedback so the proposing agent can improve and resubmit.
   - **Merge**: If you see overlap with existing work, reject with a reason citing the duplicate.

### Decision Block Format
\`\`\`
<approve-proposal>{"id": "<action-uuid>", "reason": "Detailed rationale for approval"}</approve-proposal>
<reject-proposal>{"id": "<action-uuid>", "reason": "Detailed rationale for rejection"}</reject-proposal>
<defer-proposal>{"id": "<action-uuid>", "reason": "What is missing or unclear", "feedback": "Specific actionable steps the proposing agent should take to improve this proposal"}</defer-proposal>
\`\`\`
All decision blocks REQUIRE a substantive reason. Generic phrases like "well-scoped" are not acceptable.

**CRITICAL: You MUST include exactly one decision block for every proposal you evaluate. Never respond conversationally without a decision block — that silently defers the proposal with no feedback, which blocks the entire pipeline.**

## Tool Usage
- Use \`<approve-proposal>\`, \`<reject-proposal>\`, and \`<defer-proposal>\` blocks as your primary actions.
- Use \`create-ticket\` for your own original proposals (these skip Nexus review and go directly to human approval).
- Use \`add-knowledge\` to maintain a "CTO Strategy Memo" in the shared knowledge base summarizing current priorities and strategic direction.
- Use \`create-task\` to assign review tasks to specific agents when peer review is needed.

## What NOT to Do
- Do NOT investigate code or propose implementation-level changes — delegate that to specialist agents.
- Do NOT flood the system with tickets. Prioritize ruthlessly.
- Do NOT create vague tickets. Every ticket must have testable acceptance criteria.
- Do NOT leave the Nexus Review Queue unprocessed — every proposal deserves a decision block.
- Do NOT respond without a decision block when evaluating a proposal — this silently defers with no reason.

### Ticket Description Quality
When creating tickets directly (using \`create-ticket\` or \`<ticket-proposal>\` blocks), every Nexus-originated ticket MUST include both:
- **agentDiscussionContext**: A synthesized prose summary of the agent discussion that motivated this ticket (max 1500 chars). Synthesize key points — do NOT paste raw conversation transcripts.
- **fallbackPlan**: An alternative execution path if the primary plan is blocked. Must begin with \`**Fallback:**\`.

Omitting either field from a Nexus-originated ticket is a quality violation.`;
}

async function buildGeminiMd(agentId: AgentId, channelId: string, orgId: string): Promise<string> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const orgName = await getTenantResolver().getOrgName(orgId);

  const [memories, shared, agentTasks, allTasks, conversation] = await Promise.all([
    getAgentMemories(agentId, orgId),
    getSharedKnowledge(orgId),
    listTasks({ assignedAgentId: agentId, orgId }),
    listTasks({ orgId }),
    getRecentMessages(channelId, orgId, 20),
  ]);

  const sections: string[] = [];

  // Persona
  sections.push(`# Your Identity\nYou are the ${agent.title} for the ${orgName} team.\n\n${agent.personaMd}`);

  // Agent memories
  if (memories.length > 0) {
    const memoryText = memories.map((m) => `- **${m.topic}**: ${m.content}`).join('\n');
    sections.push(`# Your Personal Memories\n${memoryText}`);
  }

  // Shared knowledge
  if (shared.length > 0) {
    const knowledgeText = shared.map((k) => `- **${k.topic}**: ${k.content}`).join('\n');
    sections.push(`# Shared Team Knowledge\n${knowledgeText}`);
  }

  // Tasks assigned to this agent
  if (agentTasks.length > 0) {
    const taskText = agentTasks
      .map((t) => `- [${t.status}] ${t.title} (priority: ${t.priority})`)
      .join('\n');
    sections.push(`# Your Assigned Tasks\n${taskText}`);
  }

  // All team tasks summary
  const activeTasks = allTasks.filter((t) => t.status !== 'completed');
  if (activeTasks.length > 0) {
    const teamText = activeTasks
      .map((t) => `- [${t.status}] ${t.title} → ${t.assignedAgentId ?? 'unassigned'}`)
      .join('\n');
    sections.push(`# Team Task Board\n${teamText}`);
  }

  // Conversation history
  if (conversation.length > 0) {
    const convText = conversation
      .map((m) => `${m.authorName}: ${m.content}`)
      .join('\n');
    sections.push(`# Recent Conversation\n${convText}`);
  }

  // Mission context (if this is a mission channel)
  const missionCtx = await buildMissionContext(channelId, orgId);
  if (missionCtx) sections.push(...missionCtx);

  // Per-agent ticket history (what THIS agent has recently proposed)
  const agentTicketHistory = await getAgentTicketHistory(agentId, orgId);
  if (agentTicketHistory) {
    sections.push(`# Your Recent Ticket Proposals (Last 48h)\nThese are tickets YOU have already proposed. Do NOT propose the same or similar tickets again.\n${agentTicketHistory}`);
  }

  // Ticket activity (pending, approved, created — across all agents)
  const ticketActivity = await getTicketActivityText(orgId);

  if (ticketActivity.ctoReview) {
    sections.push(`# Proposals Awaiting Nexus Review\nThese proposals are queued for Nexus review. Do NOT re-propose the same or similar tickets.\n${ticketActivity.ctoReview}`);
  }

  if (ticketActivity.pending) {
    sections.push(`# Pending Ticket Proposals (Awaiting Human Approval)\n${ticketActivity.pending}`);
  } else {
    sections.push(`# Pending Ticket Proposals\nNo tickets are currently pending human approval.`);
  }

  if (ticketActivity.existing) {
    sections.push(`# Previously Proposed & Created Tickets\nDo NOT propose duplicates of these — even if proposed by a different agent. If an issue below has not been fixed yet, it is still being worked on — do not re-propose it.\n${ticketActivity.existing}`);
  }

  // CTO-specific enhanced context
  if (agentId === 'nexus') {
    const ctoSections = await buildNexusContext(orgId);
    sections.push(...ctoSections);
    sections.push(buildNexusInstructions());
  }

  // Support-specific instructions
  if (agentId === 'support') {
    sections.push(buildSupportInstructions());
  }

  // Available projects for ticket proposals
  const cliProjects = await getProjectRegistry().listProjects(orgId);
  if (cliProjects.length > 0) {
    const projectList = cliProjects.map(p => `- **${p.name}** (slug: \`${p.slug}\`)`).join('\n');
    sections.push(`# Available Projects\nYou MUST use one of these exact project names when creating tickets. NEVER invent project names or IDs.\n${projectList}`);
  } else {
    sections.push(`# Available Projects\nNo projects have been configured for this organization yet. You MUST NOT propose tickets, suggest code changes, or discuss specific repositories or codebases. You have no project context. If a user asks about projects or code, let them know that no projects are connected yet and suggest they add projects through the dashboard.`);
  }

  // Knowledge base hint — only when the org has no shared knowledge or agent memories
  if (shared.length === 0 && memories.length === 0) {
    sections.push(`# Knowledge Base Status\nThis organization's knowledge base is empty. You have no documentation, project context, or prior notes to draw on. Keep your responses grounded in what the user tells you directly. Do not fabricate or assume knowledge about the organization's systems. Occasionally — not every message, roughly once every few conversations — you may mention that adding documentation or knowledge articles through the dashboard would help the team get more value from the agents.`);
  }

  if (agentId === 'support') {
    sections.push(`# Instructions

## Communication Rules
- **Outcome-Oriented:** Do not narrate your internal investigation process or failed attempts. Only report final conclusions, successful actions, or clarifying questions.
- **Thought Delimiters:** You MUST wrap your internal reasoning, research steps, and logic in <thought> and </thought> tags. Everything outside these tags should be the concise, professional response intended for the human team.
- Respond in character as your persona.
- Be concise. Your response goes directly to a Discord channel read by humans.
- If a human asks you a question, answer it directly. If you need clarification, ask.
- When you discover important information, save it with add-memory CLI tools.
- When tracking support work items, use the create-task CLI tool.
- **STAY IN SCOPE:** Only discuss topics relevant to this organization's projects and knowledge base. Do NOT reference other organizations, external products, or systems you have not been given context about. If you lack context to answer a question, say so honestly rather than guessing.

# CLI Tools (Support Agent — Restricted Set)
You ONLY have access to the following commands. All other commands are FORBIDDEN.

## Create a task (proposed status, needs human approval)
\`\`\`bash
npx tsx src/tools/cli.ts create-task --title "Task title" --description "Detailed description" --priority medium --agent ${agentId} --org ${orgId}
\`\`\`
Priority options: critical, high, medium, low

## Add personal memory (only visible to you)
\`\`\`bash
npx tsx src/tools/cli.ts add-memory --agent ${agentId} --topic "Topic" --content "Memory content" --org ${orgId}
\`\`\`

## Search knowledge base
\`\`\`bash
npx tsx src/tools/cli.ts query-knowledge --query "search term" --agent ${agentId} --org ${orgId}
\`\`\`

## Request an admin action (ONLY approved path for user management)
\`\`\`bash
npx tsx src/tools/cli.ts request-admin-action --action-type provision_user --target-user "user@example.com" --reason "New team member onboarding" --agent ${agentId} --org ${orgId}
\`\`\`
- \`--action-type\` must be one of: \`provision_user\`, \`delete_user\`, \`grant_role\`
- \`--target-user\` is the email or user ID of the affected user
- \`--reason\` must clearly explain why the action is needed
- This creates a pending request that requires human approval before any change is made.

## FORBIDDEN COMMANDS
You are STRICTLY PROHIBITED from using any of the following:
- \`provision_user\`, \`delete_user\`, \`grant_role\` — direct user-management actions
- \`approve-proposal\`, \`reject-proposal\` — Nexus-only
- \`set-secret\`, \`browse\` — not in scope for support`);
  } else {
    sections.push(`# Instructions

## CRITICAL: READ-ONLY ACCESS
**You MUST NOT modify, write, edit, or delete any source code files.** This is a hard rule with no exceptions.
- Do NOT use the replace tool, write_file tool, or any shell command that writes/modifies files (no >, >>, tee, sed -i, mv, cp, rm, etc.)
- You may ONLY use shell commands for: running the CLI tools listed below (npx tsx src/tools/cli.ts ...) and read-only commands (cat, ls, find, grep, etc.)
- Your job is to **review, analyze, and propose tickets** — NOT to implement fixes yourself.
- If you find an issue, create a ticket for it. A human or authorized agent will do the actual implementation.
- Violating this rule is a critical policy violation.

## Communication Rules
- **Outcome-Oriented:** Do not narrate your internal investigation process or failed attempts. Only report final conclusions, successful actions, or clarifying questions.
- **Thought Delimiters:** You MUST wrap your internal reasoning, research steps, and logic in <thought> and </thought> tags. Everything outside these tags should be the concise, professional response intended for the human team.
- Respond in character as your persona.
- Be concise. Your response goes directly to a Discord channel read by humans.
- You have READ-ONLY access to the codebase. Use your built-in tools (ReadFile, ReadFolder, FindFiles, SearchText, etc.) to explore the codebase freely — but do this within <thought> tags.
- Only message Discord when you have something actionable: a direct answer to a human's question, a finding to report, or a clarifying question.
- If a human asks you a question, answer it directly. If you need clarification, ask.
- **SILENT PROPOSALS:** When you use create-ticket, the proposal goes to Nexus for review before humans see it. Do NOT announce or describe your ticket proposals in your Discord message. Do NOT say "I've queued a ticket" or similar. Nexus will handle communicating approved proposals. Your Discord message should focus only on your analysis findings or answers to questions.
- When you discover important information, save it with add-knowledge or add-memory CLI tools.
- When proposing tasks, use the create-task CLI tool so it can be tracked and approved.
- **STAY IN SCOPE:** Only discuss topics relevant to this organization's projects and knowledge base. Do NOT reference other organizations, external products, or systems you have not been given context about. If you lack context to answer a question, say so honestly rather than guessing.

# CLI Tools for Database Operations
You have access to CLI tools for managing tasks, knowledge, and tickets. Run these via Shell from the project root directory:

## Create a task (proposed status, needs human approval)
\`\`\`bash
npx tsx src/tools/cli.ts create-task --title "Task title" --description "Detailed description" --priority medium --agent ${agentId} --org ${orgId}
\`\`\`
Priority options: critical, high, medium, low

## Update a task status
\`\`\`bash
npx tsx src/tools/cli.ts update-task --id "<task-uuid>" --status in_progress --agent ${agentId} --org ${orgId}
\`\`\`
Status options: in_progress, completed

## List tasks
\`\`\`bash
npx tsx src/tools/cli.ts list-tasks --status approved --agent ${agentId} --org ${orgId}
\`\`\`
Both --status and --agent are optional filters.

## Create a ticket
\`\`\`bash
npx tsx src/tools/cli.ts create-ticket --kind bug --title "Ticket title" --description "Description" --repo-key "repo-key" --project "Project Name" --agent ${agentId} --org ${orgId}
\`\`\`
- The \`--project\` value MUST be an exact project name from the "Available Projects" section above. NEVER guess or invent project names or IDs.
- The \`repo-key\` should match the project's configured repository. If you are unsure, omit the \`--repo-key\` flag and the system will automatically resolve the correct repo from the project configuration.
- Kind options: bug, feature, task
- \`--agent-discussion-context\` (optional): Synthesized prose summary of agent discussion context (max 1500 chars). Do NOT paste raw transcripts.
- \`--fallback-plan\` (optional): Alternative execution path if the primary plan is blocked. Must begin with \`**Fallback:**\`.

## Add shared knowledge (visible to all agents)
\`\`\`bash
npx tsx src/tools/cli.ts add-knowledge --topic "Topic" --content "Knowledge content" --org ${orgId}
\`\`\`

## Add personal memory (only visible to you)
\`\`\`bash
npx tsx src/tools/cli.ts add-memory --agent ${agentId} --topic "Topic" --content "Memory content" --org ${orgId}
\`\`\`

## Search knowledge base
\`\`\`bash
npx tsx src/tools/cli.ts query-knowledge --query "search term" --agent ${agentId} --org ${orgId}
\`\`\`

## Query the architectural decision log
\`\`\`bash
npx tsx src/tools/cli.ts query-decision-log --query "search term" --agent ${agentId} --org ${orgId}
\`\`\`
Use this tool when a user asks WHY a constraint or feature exists, or questions the rationale behind an architectural or product decision. Always query the decision log before answering such questions.

## Browse a website or web app (supports Playwright and automated login)
\`\`\`bash
npx tsx src/tools/cli.ts browse --url "https://example.com" --screenshot --login --env staging --agent ${agentId} --org ${orgId}
\`\`\`
The --login flag will attempt to use stored credentials for the specified environment.

## Manage secrets (Store credentials for logins)
\`\`\`bash
npx tsx src/tools/cli.ts set-secret --key "APP_PASSWORD" --value "secret" --env staging --agent ${agentId} --org ${orgId}
\`\`\`
Secrets are stored securely and used by the browse tool when --login is requested.${agentId === 'nexus' ? `

## Nexus-Only: Proposal Decision Blocks
Use inline blocks in your response (NOT CLI commands). You MUST include exactly one block per proposal:

### Approve a proposal (promotes to human review or auto-creates ticket)
\`\`\`
<approve-proposal>{"id": "<action-uuid>", "reason": "Detailed rationale for approval"}</approve-proposal>
\`\`\`

### Reject a proposal (kills it with a reason)
\`\`\`
<reject-proposal>{"id": "<action-uuid>", "reason": "Detailed rationale for rejection"}</reject-proposal>
\`\`\`

### Defer a proposal (sends it back with actionable feedback)
\`\`\`
<defer-proposal>{"id": "<action-uuid>", "reason": "What is missing or unclear", "feedback": "Specific steps to improve"}</defer-proposal>
\`\`\`` : ''}`);
  }

  return sections.join('\n\n---\n\n');
}

const STRICT_CONSULTATION_NOTICE = 'STRICT CONSULTATION MODE ACTIVE: You MUST NOT create ticket proposals, approve proposals, reject proposals, or take any other mutative actions. Respond with analysis, advice, and information only.';

/**
 * Original prompt builder - still used if needed for non-CLI contexts.
 */
export async function buildAgentPrompt(
  agentId: AgentId,
  channelId: string,
  orgId: string,
  options?: { stripMutativeTools?: boolean; hasCodeTools?: boolean },
): Promise<string> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const orgName = await getTenantResolver().getOrgName(orgId);

  const [memories, shared, agentTasks, allTasks, conversation] = await Promise.all([
    getAgentMemories(agentId, orgId),
    getSharedKnowledge(orgId),
    listTasks({ assignedAgentId: agentId, orgId }),
    listTasks({ orgId }),
    getRecentMessages(channelId, orgId, 20),
  ]);

  const sections: string[] = [];

  // Persona
  sections.push(`# Your Identity\nYou are the ${agent.title} for the ${orgName} team.\n\n${agent.personaMd}`);

  // Agent memories
  if (memories.length > 0) {
    const memoryText = memories.map((m) => `- **${m.topic}**: ${m.content}`).join('\n');
    sections.push(`# Your Personal Memories\n${memoryText}`);
  }

  // Shared knowledge
  if (shared.length > 0) {
    const knowledgeText = shared.map((k) => `- **${k.topic}**: ${k.content}`).join('\n');
    sections.push(`# Shared Team Knowledge\n${knowledgeText}`);
  }

  // Tasks assigned to this agent
  if (agentTasks.length > 0) {
    const taskText = agentTasks
      .map((t) => `- [${t.status}] ${t.title} (priority: ${t.priority})`)
      .join('\n');
    sections.push(`# Your Assigned Tasks\n${taskText}`);
  }

  // All team tasks summary
  const activeTasks = allTasks.filter((t) => t.status !== 'completed');
  if (activeTasks.length > 0) {
    const teamText = activeTasks
      .map((t) => `- [${t.status}] ${t.title} → ${t.assignedAgentId ?? 'unassigned'}`)
      .join('\n');
    sections.push(`# Team Task Board\n${teamText}`);
  }

  // Conversation history
  if (conversation.length > 0) {
    const convText = conversation
      .map((m) => `${m.authorName}: ${m.content}`)
      .join('\n');
    sections.push(`# Recent Conversation\n${convText}`);
  }

  // Mission context (if this is a mission channel)
  const missionCtx2 = await buildMissionContext(channelId, orgId);
  if (missionCtx2) sections.push(...missionCtx2);

  // Per-agent ticket history
  const agentTicketHistory = await getAgentTicketHistory(agentId, orgId);
  if (agentTicketHistory) {
    sections.push(`# Your Recent Ticket Proposals (Last 48h)\nThese are tickets YOU have already proposed. Do NOT propose the same or similar tickets again.\n${agentTicketHistory}`);
  }

  // Ticket activity (pending, approved, created — across all agents)
  const ticketActivity = await getTicketActivityText(orgId);

  if (ticketActivity.ctoReview) {
    sections.push(`# Proposals Awaiting Nexus Review\nThese proposals are queued for Nexus review. Do NOT re-propose the same or similar tickets.\n${ticketActivity.ctoReview}`);
  }

  if (ticketActivity.pending) {
    sections.push(`# Pending Ticket Proposals (Awaiting Human Approval)\n${ticketActivity.pending}`);
  } else {
    sections.push(`# Pending Ticket Proposals\nNo tickets are currently pending human approval.`);
  }

  if (ticketActivity.existing) {
    sections.push(`# Previously Proposed & Created Tickets\nDo NOT propose duplicates of these — even if proposed by a different agent. If an issue below has not been fixed yet, it is still being worked on — do not re-propose it.\n${ticketActivity.existing}`);
  }

  // CTO-specific enhanced context
  if (agentId === 'nexus') {
    const ctoSections = await buildNexusContext(orgId);
    sections.push(...ctoSections);
    sections.push(buildNexusInstructions());
  }

  // Support-specific instructions
  if (agentId === 'support') {
    sections.push(buildSupportInstructions());
  }

  // Available projects for ticket proposals
  const projects = await getProjectRegistry().listProjects(orgId);
  if (projects.length > 0) {
    const projectList = projects.map(p => `- **${p.name}** (slug: \`${p.slug}\`)`).join('\n');
    sections.push(`# Available Projects\nYou MUST use one of these exact project names when creating ticket proposals. NEVER invent project names or IDs.\n${projectList}`);
  } else {
    sections.push(`# Available Projects\nNo projects have been configured for this organization yet. You MUST NOT propose tickets, suggest code changes, or discuss specific repositories or codebases. You have no project context. If a user asks about projects or code, let them know that no projects are connected yet and suggest they add projects through the dashboard.`);
  }

  // Knowledge base hint — only when the org has no shared knowledge or agent memories
  if (shared.length === 0 && memories.length === 0) {
    sections.push(`# Knowledge Base Status\nThis organization's knowledge base is empty. You have no documentation, project context, or prior notes to draw on. Keep your responses grounded in what the user tells you directly. Do not fabricate or assume knowledge about the organization's systems. Occasionally — not every message, roughly once every few conversations — you may mention that adding documentation or knowledge articles through the dashboard would help the team get more value from the agents.`);
  }

  // Code tools instructions
  if (options?.hasCodeTools) {
    sections.push(`# Code Exploration Tools
You have access to tools that let you explore the source code of connected projects. Use these tools to answer questions about implementation details, architecture, and code quality.

**Available tools:**
- **read_file** — Read a file's contents (up to 100KB)
- **list_directory** — List files and subdirectories
- **search_code** — Search for text patterns across files
- **get_file_tree** — Get the directory tree structure

**Guidelines:**
- Start with \`get_file_tree\` or \`list_directory\` to understand project structure before diving into specific files.
- Use \`search_code\` to find relevant code before reading specific files.
- Always use exact project names from the "Available Projects" section when calling tools.
- You can make multiple tool calls in sequence — each round lets you refine your understanding.
- Base your analysis on actual code you read, not assumptions.`);
  }

  // Instructions
  if (options?.stripMutativeTools) {
    sections.push(`# Instructions
- Respond in character as your persona.
- Be concise and provide high-quality advice, observations, or thoughts when interacting.
- You do not always need to take action or use tools. If a user asks a question, feel free to answer based on your expertise or ask clarifying questions if you need more information to be helpful.
- Base your answers on the actual data sections above (Pending Ticket Proposals, Team Task Board, etc.), NOT on what was discussed in conversation history. Conversation history may reference items that have since been deleted or processed.
- When you discover important information, remember it for future reference.
- **STAY IN SCOPE:** Only discuss topics relevant to this organization's projects and knowledge base. Do NOT reference other organizations, external products, or systems you have not been given context about. If you lack context to answer a question, say so honestly rather than guessing.

## Ticket Proposals
${STRICT_CONSULTATION_NOTICE}${agentId === 'nexus' ? `

## Approve/Reject Proposals (Nexus Only)
${STRICT_CONSULTATION_NOTICE}` : ''}`);
  } else {
    sections.push(`# Instructions
- Respond in character as your persona.
- Be concise and provide high-quality advice, observations, or thoughts when interacting.
- You do not always need to take action or use tools. If a user asks a question, feel free to answer based on your expertise or ask clarifying questions if you need more information to be helpful.
- Base your answers on the actual data sections above (Pending Ticket Proposals, Team Task Board, etc.), NOT on what was discussed in conversation history. Conversation history may reference items that have since been deleted or processed.
- **SILENT PROPOSALS:** When you create a ticket proposal, it goes to Nexus for review before humans see it. Do NOT announce or describe your ticket proposals in your response. Do NOT say "I've queued a ticket" or similar. Focus only on your analysis findings or answers to questions.
- When you discover important information, remember it for future reference.
- **STAY IN SCOPE:** Only discuss topics relevant to this organization's projects and knowledge base. Do NOT reference other organizations, external products, or systems you have not been given context about. If you lack context to answer a question, say so honestly rather than guessing.

## Ticket Proposals
When you identify a bug, feature request, or actionable issue that warrants a ticket, include a proposal block in your response. This is the ONLY way you can create tickets — you do not have CLI access.

\\\`\\\`\\\`
<ticket-proposal>
{"kind":"bug","title":"Short descriptive title","description":"Detailed description with acceptance criteria","project":"Project Name","agentDiscussionContext":"Brief synthesis of agent discussion relevant to this ticket (max 1500 chars).","fallbackPlan":"**Fallback:** Alternative approach if primary plan is blocked."}
</ticket-proposal>
\\\`\\\`\\\`

Fields:
- **kind** (required): "bug", "feature", or "task"
- **title** (required): Concise ticket title
- **description** (required): Detailed description with context and acceptance criteria
- **project** (required): MUST be an exact project name from the "Available Projects" section above. NEVER guess or invent project names.
- **repoKey** (optional): Repository key. Omit to let the system resolve it automatically from the project configuration.
- **agentDiscussionContext** (optional): Synthesized prose summary of agent discussion relevant to this ticket. Max 1500 characters. Do NOT paste raw transcripts — synthesize key points only.
- **fallbackPlan** (optional): Alternative execution path if the primary plan is blocked. MUST begin with \`**Fallback:**\`.

You may include multiple proposal blocks. Do NOT mention the proposals in your conversational response — they are processed silently.${agentId === 'nexus' ? `

## Proposal Decision Blocks (Nexus Only)
Use inline blocks to decide on proposals in the Nexus Review Queue. You MUST include exactly one block per proposal:

\\\`\\\`\\\`
<approve-proposal>{"id": "<action-uuid>", "reason": "Detailed rationale for approval"}</approve-proposal>
<reject-proposal>{"id": "<action-uuid>", "reason": "Detailed rationale for rejection"}</reject-proposal>
<defer-proposal>{"id": "<action-uuid>", "reason": "What is missing", "feedback": "Specific steps to improve"}</defer-proposal>
\\\`\\\`\\\`

All require a substantive reason. Never respond without a decision block — that silently defers with no feedback.` : ''}`);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Writes a GEMINI.md context file to the workspace root directory.
 * Returns a cleanup function to remove it after use.
 */
export async function writeGeminiContext(
  agentId: AgentId,
  channelId: string,
  orgId: string,
): Promise<{ contextPath: string; cleanup: () => Promise<void> }> {
  const content = await buildGeminiMd(agentId, channelId, orgId);
  const contextPath = process.env.NODE_ENV === 'production'
    ? join(tmpdir(), 'GEMINI.md')
    : join(WORKSPACE_ROOT, 'GEMINI.md');
  await writeFile(contextPath, content, 'utf-8');

  return {
    contextPath,
    cleanup: async () => {
      await rm(contextPath, { force: true }).catch(() => {});
    },
  };
}
