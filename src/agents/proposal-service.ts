import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../logger.js';

export interface ExistingProposal {
  title: string;
  body: string;
  kind: string;
}

export interface ProposalCheckResult {
  isDuplicate: boolean;
  classification: 'DUPLICATE' | 'VALID_SUBTASK' | 'UNIQUE';
  reason: string;
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
- VALID_SUBTASK: The new proposal is domain-specific follow-on work proposed by a specialist agent (e.g. security, SRE, QA, UX). Specialist agents proposing domain work are VALID_SUBTASK, not DUPLICATE.
- UNIQUE: The new proposal covers genuinely different scope from all existing proposals.

Key rule: If a specialist agent is proposing domain-specific work (threat modelling, alerting, accessibility audits, test coverage, etc.) that relates to but does not duplicate an existing proposal, classify it as VALID_SUBTASK.

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

---

Existing proposals:
${existingList}

New proposal:
[${proposal.kind}] ${proposal.title}: ${proposal.body}

Respond with raw JSON only, no markdown fences:
{ "classification": "DUPLICATE" | "VALID_SUBTASK" | "UNIQUE", "reason": "<brief explanation>" }`;

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { classification: string; reason: string };

    const classification = parsed.classification as ProposalCheckResult['classification'];
    const reason = parsed.reason;
    const isDuplicate = classification === 'DUPLICATE';

    return { isDuplicate, classification, reason };
  } catch (err) {
    log.warn({ err }, 'Duplicate check failed, failing open and allowing proposal');
    return {
      isDuplicate: false,
      classification: 'UNIQUE',
      reason: 'Duplicate check unavailable, allowing proposal.',
    };
  }
}
