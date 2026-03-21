import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../logger.js';

export interface ExistingProposal {
  id?: string;
  title: string;
  body: string;
  kind: string;
}

export interface ProposalCheckResult {
  isDuplicate: boolean;
  classification: 'DUPLICATE' | 'ROOT_CAUSE_OVERLAP' | 'VALID_SUBTASK' | 'UNIQUE';
  reason: string;
  existingProposalId?: string;
  matchedTitle?: string;
}

export async function checkForDuplicate(
  proposal: ExistingProposal,
  existingProposals: ExistingProposal[],
  geminiApiKey: string,
): Promise<ProposalCheckResult> {
  const log = logger;

  if (existingProposals.length === 0) {
    return {
      isDuplicate: false,
      classification: 'UNIQUE',
      reason: 'No existing proposals to compare against.',
    };
  }

  try {
    const existingList = existingProposals
      .map((p, i) => `${i + 1}. [${p.kind}] ${p.title}: ${p.body}`)
      .join('\n');

    const prompt = `You are a ticket classifier. Given a set of existing proposals and a new proposal, classify the new proposal as one of:
- DUPLICATE: The new proposal covers the same scope as an existing proposal (including paraphrases or rewordings of the same work).
- ROOT_CAUSE_OVERLAP: The new proposal targets a different task but operates on the same underlying component, file, or root cause as an existing proposal submitted by a different agent. These proposals would produce conflicting or redundant changes to the same codebase surface area if executed concurrently.
- VALID_SUBTASK: The new proposal is domain-specific follow-on work proposed by a specialist agent (e.g. security, SRE, QA, UX). Specialist agents proposing domain work are VALID_SUBTASK, not DUPLICATE.
- UNIQUE: The new proposal covers genuinely different scope from all existing proposals.

Key rules:
- If a specialist agent is proposing domain-specific work (threat modelling, alerting, accessibility audits, test coverage, etc.) that relates to but does not duplicate an existing proposal, classify it as VALID_SUBTASK.
- If two proposals from different agents both modify the same file or component (e.g. one patches a security vulnerability and another refactors performance in the same module), classify the newer one as ROOT_CAUSE_OVERLAP even if the stated tasks differ.

Examples:

Example 1:
Existing: [feature] Add OAuth2 auth: Implement OAuth2 authentication flow for the API.
New: [feature] Add OAuth2 auth: Add OAuth2 authentication support to the API endpoints.
Classification: DUPLICATE
Reason: The new proposal covers identical scope to the existing one — both implement OAuth2 auth for the API.

Example 2:
Existing: [feature] Add OAuth2 auth: Implement OAuth2 authentication flow for the API.
New: [task] CISO: threat model and pen test plan for OAuth2 impl: Produce a threat model and penetration testing plan for the OAuth2 implementation.
Classification: VALID_SUBTASK
Reason: The new proposal is security specialist work (threat modelling and pen testing) that supports the OAuth2 feature without duplicating it.

Example 3:
Existing: [feature] Build metrics dashboard: Create a dashboard showing key system metrics.
New: [task] SRE: alerting rules and PagerDuty integration for dashboard: Define alerting thresholds and wire up PagerDuty for the metrics dashboard.
Classification: VALID_SUBTASK
Reason: The new proposal is SRE specialist work (alerting and incident management) that extends the dashboard feature without duplicating it.

Example 4:
Existing: [feature] Implement user registration flow: Build the end-to-end user registration experience.
New: [feature] Create user registration form and API endpoint: Add a registration form on the frontend and the corresponding API endpoint.
Classification: DUPLICATE
Reason: The new proposal is a paraphrase of the existing one — both cover the same user registration work.

Example 5:
Existing: [feature] Add file upload to settings: Allow users to upload files from the settings page.
New: [task] UX: WCAG accessibility audit for file upload: Conduct a WCAG accessibility audit and remediation for the file upload feature.
Classification: VALID_SUBTASK
Reason: The new proposal is UX specialist work (accessibility audit) that supports the file upload feature without duplicating it.

Example 6:
Existing: [task] Migrate database to Postgres: Migrate the application database from MySQL to PostgreSQL.
New: [task] QA: unit tests for migration scripts: Write unit tests covering all database migration scripts.
Classification: VALID_SUBTASK
Reason: The new proposal is QA specialist work (test coverage for migration scripts) that supports the migration task without duplicating it.

Example 7:
Existing: [task] CISO: patch CVE-2024-1234 in src/auth/token-validator.ts: Apply security patch to fix token validation bypass vulnerability in the auth module.
New: [task] SRE: refactor token validation for performance in src/auth/token-validator.ts: Rewrite token validation logic to reduce P99 latency.
Classification: ROOT_CAUSE_OVERLAP
Reason: Both proposals operate on the same file (src/auth/token-validator.ts). Concurrent execution would produce conflicting changes to the same component. The agent should merge acceptance criteria with the existing proposal.

Example 8:
Existing: [feature] Optimise database query layer in src/db/query-builder.ts: Improve query builder to reduce N+1 queries and add connection pooling.
New: [task] CISO: SQL injection hardening in src/db/query-builder.ts: Add parameterised query enforcement and input sanitisation to the query builder.
Classification: ROOT_CAUSE_OVERLAP
Reason: Both proposals target the same file (src/db/query-builder.ts) for different reasons (performance vs security). Executing them independently risks merge conflicts and duplicated refactoring effort. Acceptance criteria should be consolidated.

---

Existing proposals:
${existingList}

New proposal:
[${proposal.kind}] ${proposal.title}: ${proposal.body}

Respond with raw JSON only, no markdown fences:
{ "classification": "DUPLICATE" | "ROOT_CAUSE_OVERLAP" | "VALID_SUBTASK" | "UNIQUE", "matchedIndex": <1-based index of the matching existing proposal, or null if UNIQUE>, "reason": "<brief explanation>" }`;

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { classification: string; matchedIndex: number | null; reason: string };

    const classification = parsed.classification as ProposalCheckResult['classification'];
    const reason = parsed.reason;
    const isDuplicate = classification === 'DUPLICATE' || classification === 'ROOT_CAUSE_OVERLAP';

    let existingProposalId: string | undefined;
    let matchedTitle: string | undefined;
    if (isDuplicate && parsed.matchedIndex != null) {
      const matched = existingProposals[parsed.matchedIndex - 1];
      if (matched) {
        existingProposalId = matched.id;
        matchedTitle = matched.title;
      }
    }

    return { isDuplicate, classification, reason, existingProposalId, matchedTitle };
  } catch (err) {
    log.warn({ err }, 'Duplicate check failed, failing open and allowing proposal');
    return {
      isDuplicate: false,
      classification: 'UNIQUE',
      reason: 'Duplicate check unavailable, allowing proposal.',
    };
  }
}
