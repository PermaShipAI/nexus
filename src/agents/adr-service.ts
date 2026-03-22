/**
 * Automated ADR Drafting Service
 *
 * Detects recurring rejection patterns in pending proposals and drafts
 * Architecture Decision Records (ADRs) for human review (HITL) before
 * they are committed to agents/decisions/.
 *
 * Acceptance criteria:
 * - N>=3 rejected proposals with a matching semantic failure class in 30 days
 * - Draft ADR links to source proposal IDs as evidence
 * - Mandatory Human-in-the-Loop approval before the ADR is committed
 * - Telemetry: adr_auto_drafted, adr_human_approved, duplicate_proposal_prevented
 */

import { db } from '../db/index.js';
import { pendingActions, adrDrafts } from '../db/schema.js';
import { eq, and, gte, desc } from 'drizzle-orm';
import { getLLMProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';
import { logAdrEvent } from '../../agents/telemetry/logger.js';
import { parseArgs } from '../utils/parse-args.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ADR_THRESHOLD = 3; // Minimum rejected proposals to trigger a draft
const WINDOW_DAYS = 30;

interface RejectedProposal {
  id: string;
  title: string;
  description: string;
  rejectionReason: string;
  agentId: string;
  rejectedAt: Date;
}

interface FailureCluster {
  failureClass: string;
  proposals: RejectedProposal[];
}

/**
 * Classify a list of rejected proposals into semantic failure classes.
 * Returns a list of clusters where each cluster groups proposals by shared failure theme.
 */
async function classifyFailureClusters(proposals: RejectedProposal[]): Promise<FailureCluster[]> {
  if (proposals.length === 0) return [];

  const lines = proposals.map((p, i) =>
    `[${i + 1}] Title: "${p.title}" | Rejection reason: "${p.rejectionReason.slice(0, 300)}"`,
  );

  const prompt = `You are an engineering process analyst. Group the following rejected ticket proposals by their underlying architectural or process failure theme.

REJECTED PROPOSALS:
${lines.join('\n')}

Instructions:
- Assign each proposal a short, reusable "failure class" label (e.g. "auth-scope-violation", "missing-rollback-plan", "cross-team-dependency-not-resolved").
- Group proposals that share the same root cause under the same failure class.
- Return JSON only — no prose, no markdown fences.

Output format (JSON array):
[
  {
    "failureClass": "<kebab-case-label>",
    "indices": [1, 3, 5]
  }
]`;

  try {
    const response = await getLLMProvider().generateText({
      model: 'ROUTER',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const raw = response.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(raw) as Array<{ failureClass: string; indices: number[] }>;

    return parsed
      .filter((c) => c.failureClass && Array.isArray(c.indices) && c.indices.length >= ADR_THRESHOLD)
      .map((c) => ({
        failureClass: c.failureClass,
        proposals: c.indices
          .map((i) => proposals[i - 1])
          .filter(Boolean),
      }))
      .filter((c) => c.proposals.length >= ADR_THRESHOLD);
  } catch (err) {
    logger.warn({ err }, 'adr-service: failed to classify failure clusters');
    return [];
  }
}

/**
 * Generate ADR markdown content for a given failure cluster.
 */
async function generateAdrContent(cluster: FailureCluster): Promise<string> {
  const evidenceBullets = cluster.proposals
    .map((p) => `- **${p.title}** (proposal \`${p.id}\`, rejected ${p.rejectedAt.toISOString().split('T')[0]}): ${p.rejectionReason.slice(0, 200)}`)
    .join('\n');

  const prompt = `You are a senior engineering architect writing an Architecture Decision Record (ADR).

FAILURE CLASS: ${cluster.failureClass}
RECURRING REJECTIONS (evidence):
${evidenceBullets}

Write a concise ADR in the following EXACT markdown format (fill in placeholders):

# ADR: <Short Decision Title>

## Status
Proposed (pending human approval)

## Context
<1-2 paragraphs describing the recurring problem pattern inferred from the evidence above>

## Decision
<1-2 paragraphs stating the architectural rule or constraint that should prevent recurrence>

## Rationale
<Bullet points explaining WHY this decision was made, linking to the recurring rejection pattern>

## Evidence
<List the evidence proposals — use the exact bullet list provided below, do not modify it>

## Consequences
<Brief list of trade-offs or implications>

Use only the evidence provided. Do not invent details. The "Evidence" section MUST include these exact bullets:
${evidenceBullets}`;

  const response = await getLLMProvider().generateText({
    model: 'AGENT',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  return response.trim();
}

/**
 * Check for recurring rejection patterns and draft ADRs if the threshold is met.
 * Call this after each proposal rejection.
 */
export async function checkAndTriggerAdrDrafting(orgId: string): Promise<void> {
  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Fetch rejected proposals from the last 30 days
    const rejected = await db
      .select()
      .from(pendingActions)
      .where(
        and(
          eq(pendingActions.orgId, orgId),
          eq(pendingActions.status, 'rejected'),
          gte(pendingActions.resolvedAt, since),
        ),
      )
      .orderBy(desc(pendingActions.resolvedAt))
      .limit(200);

    if (rejected.length < ADR_THRESHOLD) return;

    const proposals: RejectedProposal[] = rejected
      .map((action) => {
        const args = parseArgs(action.args);
        const reason = (args.ctoRejectionReason ?? args.withdrawReason ?? '') as string;
        if (!reason) return null;
        return {
          id: action.id,
          title: (args.title as string) ?? action.description,
          description: (args.description as string) ?? '',
          rejectionReason: reason,
          agentId: action.agentId,
          rejectedAt: action.resolvedAt ?? action.createdAt,
        };
      })
      .filter((p): p is RejectedProposal => p !== null);

    if (proposals.length < ADR_THRESHOLD) return;

    const clusters = await classifyFailureClusters(proposals);
    if (clusters.length === 0) return;

    for (const cluster of clusters) {
      // Check if a draft ADR for this failure class already exists (pending or approved)
      const existing = await db
        .select({ id: adrDrafts.id })
        .from(adrDrafts)
        .where(
          and(
            eq(adrDrafts.orgId, orgId),
            eq(adrDrafts.failureClass, cluster.failureClass),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        logger.info({ failureClass: cluster.failureClass }, 'adr-service: ADR draft already exists for failure class, skipping');
        continue;
      }

      const content = await generateAdrContent(cluster);
      const title = `ADR: ${cluster.failureClass.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`;
      const evidenceIds = cluster.proposals.map((p) => p.id);

      const [draft] = await db
        .insert(adrDrafts)
        .values({
          orgId,
          title,
          content,
          failureClass: cluster.failureClass,
          evidenceActionIds: evidenceIds,
          status: 'pending_review',
        })
        .returning();

      logger.info(
        { draftId: draft.id, failureClass: cluster.failureClass, evidenceCount: evidenceIds.length },
        'adr-service: ADR draft created, awaiting HITL approval',
      );

      logAdrEvent('adr_auto_drafted', {
        draftId: draft.id,
        orgId,
        failureClass: cluster.failureClass,
        evidenceCount: evidenceIds.length,
      });
    }
  } catch (err) {
    logger.error({ err, orgId }, 'adr-service: checkAndTriggerAdrDrafting failed');
  }
}

/**
 * Approve an ADR draft: commit it as a markdown file to agents/decisions/ and update status.
 * This is the HITL gate — only called via the human-facing API.
 */
export async function approveAdrDraft(draftId: string, orgId: string): Promise<{ success: boolean; committedPath?: string; error?: string }> {
  const [draft] = await db
    .select()
    .from(adrDrafts)
    .where(and(eq(adrDrafts.id, draftId), eq(adrDrafts.orgId, orgId)))
    .limit(1);

  if (!draft) return { success: false, error: 'ADR draft not found' };
  if (draft.status !== 'pending_review') return { success: false, error: `ADR draft is already ${draft.status}` };

  // Derive filename from failure class
  const slug = draft.failureClass.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const filename = `adr-${slug}.md`;
  const decisionsDir = join(process.cwd(), 'agents', 'decisions');
  const filePath = join(decisionsDir, filename);
  const relPath = `agents/decisions/${filename}`;

  try {
    await mkdir(decisionsDir, { recursive: true });
    await writeFile(filePath, draft.content, 'utf-8');
  } catch (err) {
    logger.error({ err, filePath }, 'adr-service: failed to write ADR file');
    return { success: false, error: 'Failed to write ADR file to disk' };
  }

  await db
    .update(adrDrafts)
    .set({ status: 'approved', committedPath: relPath, updatedAt: new Date() })
    .where(eq(adrDrafts.id, draftId));

  logger.info({ draftId, committedPath: relPath }, 'adr-service: ADR approved and committed');

  logAdrEvent('adr_human_approved', {
    draftId,
    orgId,
    failureClass: draft.failureClass,
    committedPath: relPath,
  });

  return { success: true, committedPath: relPath };
}

/**
 * Reject an ADR draft (human dismisses it).
 */
export async function rejectAdrDraft(draftId: string, orgId: string): Promise<{ success: boolean; error?: string }> {
  const [draft] = await db
    .select()
    .from(adrDrafts)
    .where(and(eq(adrDrafts.id, draftId), eq(adrDrafts.orgId, orgId)))
    .limit(1);

  if (!draft) return { success: false, error: 'ADR draft not found' };
  if (draft.status !== 'pending_review') return { success: false, error: `ADR draft is already ${draft.status}` };

  await db
    .update(adrDrafts)
    .set({ status: 'rejected', updatedAt: new Date() })
    .where(eq(adrDrafts.id, draftId));

  logger.info({ draftId }, 'adr-service: ADR draft rejected by human');
  return { success: true };
}
