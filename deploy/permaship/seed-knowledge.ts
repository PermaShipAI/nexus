/**
 * One-time script to seed the shared knowledge base with project analyses.
 * Run with: npx tsx src/seed-knowledge.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { knowledgeEntries } from './db/schema.js';
import { config } from './config.js';

const client = postgres(config.DATABASE_URL);
const db = drizzle(client);

const SEED_DATA = [
  {
    topic: 'Project: permaship-control',
    content: `## Permaship Control (claude-conductor) — AI Workflow Orchestration Engine

**What it is:** The core backend of PermaShip — a multi-tenant AI workflow orchestrator that automates software development tasks by executing Claude Code instances. It processes work tickets through an intelligent AI-driven pipeline: triage → planning → implementation → testing → code push.

**Domain:** https://control.permaship.ai

**Department:** Core Engineering / AgentOps

**Key Technical Context:**
- Built with TypeScript, Fastify, Drizzle ORM (PostgreSQL), Redis.
- Orchestrates Claude Code runners using a proprietary "Suggester-Executor" architecture.
- Infra: AWS ECS Fargate (API + Worker + Scheduler services), RDS, EFS, S3.
- Security: RBAC-enforced multi-tenancy, secrets management, audit logs.
- Integrated with GitHub/GitLab webhooks and OAuth.

**SRE/QA Context:**
- High reliability required: handles critical CI/CD push flows.
- Complex state transitions: tickets move through 8 distinct status phases.
- Integration-heavy: talks to LLM providers (Google, Anthropic), Version Control (GitLab), and Billing (Stripe).`,
  },
  {
    topic: 'Project: commons',
    content: `## Commons (oss-bug-fixer) — Automated Open-Source Contribution Engine

**What it is:** A specialized discoverability and contribution system that identifies fixable bugs in popular Open Source projects and automates the proposal/PR process using PermaShip agents.

**Department:** Product / Community

**Key Context:**
- Uses PermaShip API to create/track bug-fix tickets.
- Monitors GitHub trending and issue trackers for specific "good first issue" patterns.
- Attribution: Identifies contributors (issue author, maintainers, reviewers), fetches GitHub profiles with 7-day cache, extracts social accounts (Twitter, LinkedIn, website).
- Reputation Engine: Tracks PR merge rates and code quality scores.`,
  },
  {
    topic: 'Project: comms',
    content: `## Comms (permaship-comms) — Unified Slack + Discord Communication Gateway

**What it is:** The central message bus for all user-agent interactions. It abstracts the platform-specific complexities (Slack vs. Discord) into a single, unified PermaShip communication API.

**Department:** Platform / UX

**Key Context:**
- Conductor Integration: HMAC-SHA256 signed HTTP for all communication. Bot → Conductor: create tickets, forward messages/interactions. Conductor → Bot: send updates to threads/channels/DMs.
- Unified Addressing: Uses 'discord:<id>' and 'slack:<id>' format.
- OAuth Provisioning: Conductor creates workspace connections during OAuth flow via POST /v1/connections.
- Idempotency: X-Event-ID header prevents duplicate event processing.`,
  },
  {
    topic: 'Project: qa',
    content: `## QA (permaship-qa) — End-to-End Integration Test Suite

**What it is:** A comprehensive quality assurance project using Playwright to validate the entire PermaShip ecosystem through automated browser-based E2E tests.

**Department:** QA / Reliability

**Key Context:**
- Validates critical flows: User signup/login, project creation, ticket implementation, billing lifecycle.
- Headless browser automation targeting staging and production environments.
- Reports into PermaShip Control via the API keys system.
- Critical for Release Engineering to verify green builds before promotion.`,
  },
  {
    topic: 'Project: website',
    content: `## Website (permaship-website) — Marketing & Product Portal

**What it is:** The public face of PermaShip. A high-performance web portal built for lead generation, documentation, and product showcase.

**Department:** Marketing / Product

**Key Context:**
- Tech stack: Python/Flask, Tailwind CSS.
- API Endpoint: POST /api/contact — handles demo requests and doc signup emails with rate limiting (5/IP/hour) and SMTP delivery to hello@permaship.ai.
- Content managed via CMS/Markdown for docs and blog.`,
  },
  {
    topic: 'Project: agents',
    content: `## Agents — AI Agent Management System

**What it is:** The codebase you are currently analyzing. It manages the lifecycle, personas, and coordination of the PermaShip AI specialist team.

**Department:** Core Engineering / AI

**Key Context:**
- Personas: CISO, QA Manager, SRE, UX Designer, Nexus (CTO), VOC, AgentOps, FinOps, Release Engineering.
- Orchestrates multi-agent reviews and strategy sessions.
- Directly integrated with PermaShip Control for ticket proposals and knowledge persistence.`,
  },
  {
    topic: 'PermaShip Ecosystem Overview',
    content: `## PermaShip Ecosystem — Standard Operating Procedures

**Core Philosophy:** Every piece of work must be tracked via a Ticket in PermaShip Control. Agents propose work, Humans approve it, and Claude-powered runners implement it.

**Project Roles:**
1. **Permaship Control (claude-conductor)** — The core engine. Multi-tenant orchestrator that processes tickets through AI pipeline (triage → plan → implement → test → push). Manages orgs, projects, billing, secrets, approvals, integrations.
2. **Comms (permaship-comms)** — Communication gateway. Bridges Slack/Discord ↔ Conductor with HMAC-signed, encrypted communication. Manages workspace connections and channel routing.
3. **Commons (oss-bug-fixer)** — Discovery engine. Finds fixable OSS bugs on GitHub, scores them, checks policies, creates Conductor tickets, tracks PR outcomes, generates marketing content.
4. **QA (permaship-qa)** — Quality gate. Playwright E2E tests validating the entire Conductor web app (auth, tickets, AI assistant, billing, settings).
5. **Website (permaship-website)** — Marketing portal. Flask site showcasing platform capabilities, pricing, security. Drives demo bookings and lead generation.
6. **Agents** — AI advisory team. Four AI personas (CISO, QA Manager, SRE, UX Designer) that analyze codebases, propose work, create tickets, and maintain shared knowledge via Discord.

**The "Definition of Done" (Nexus Standard):**
Every ticket proposed by an agent MUST include:
1. **Testable Acceptance Criteria:** How will a Human/QA verify this is fixed?
2. **Explicit Measurement Plan:** Which metric will move? (e.g., error rate, latency, coverage)
3. **Cross-functional review:** Which other agent needs to sign off? (e.g., SRE for infra, CISO for auth)
4. **Validated Rollback/Mitigation Strategy:** How do we undo this if it breaks production?

**Security Standards:**
- NO secrets in code.
- ALL data must be org-scoped.
- READ-ONLY access to monorepo for agents.`,
  },
];

async function seed() {
  console.log(`Seeding ${SEED_DATA.length} knowledge entries...`);

  for (const entry of SEED_DATA) {
    await db.insert(knowledgeEntries).values({
      orgId: config.PERMASHIP_ORG_ID,
      kind: 'shared',
      topic: entry.topic,
      content: entry.content,
    });
    console.log(`  ✓ ${entry.topic}`);
  }

  console.log('Done!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
