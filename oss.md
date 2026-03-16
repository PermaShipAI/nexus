# Open-Sourcing the Agent System

This document covers how to turn `@permaship/agents` into a standalone open-source project **while continuing to use it as the agent system inside PermaShip**. The core idea: don't rip out PermaShip code — extract interfaces at every integration boundary, move the current PermaShip implementations behind those interfaces, and ship local-only defaults alongside them.

PermaShip then becomes one adapter set that plugs into the OSS core. As the OSS project improves, PermaShip upgrades by bumping the version. TypeScript enforces the contracts.

---

## Table of Contents

1. [Architecture: Core + Adapters](#1-architecture-core--adapters)
2. [The Eight Interface Boundaries](#2-the-eight-interface-boundaries)
3. [Interface 1: LLM Provider](#3-interface-1-llm-provider)
4. [Interface 2: Communication Adapter](#4-interface-2-communication-adapter)
5. [Interface 3: Project Registry](#5-interface-3-project-registry)
6. [Interface 4: Ticket Tracker](#6-interface-4-ticket-tracker)
7. [Interface 5: Commit Provider (VCS)](#7-interface-5-commit-provider-vcs)
8. [Interface 6: Knowledge Source](#8-interface-6-knowledge-source)
9. [Interface 7: Tenant Resolver](#9-interface-7-tenant-resolver)
10. [Interface 8: Usage Sink](#10-interface-8-usage-sink)
11. [Repo Structure & Packaging](#11-repo-structure--packaging)
12. [How PermaShip Consumes the OSS Core](#12-how-permaship-consumes-the-oss-core)
13. [Adapter Registry & Startup Wiring](#13-adapter-registry--startup-wiring)
14. [Configuration Strategy](#14-configuration-strategy)
15. [Database & Migrations](#15-database--migrations)
16. [What Stays in the OSS Core (Unchanged)](#16-what-stays-in-the-oss-core-unchanged)
17. [Branding & Licensing](#17-branding--licensing)
18. [Infrastructure & Deployment](#18-infrastructure--deployment)
19. [Documentation](#19-documentation)
20. [CI/CD](#20-cicd)
21. [Migration Roadmap](#21-migration-roadmap)
22. [File-by-File Change Index](#22-file-by-file-change-index)
23. [Risk & Compatibility](#23-risk--compatibility)

---

## 1. Architecture: Core + Adapters

### The Wrong Approach (What Not to Do)

Delete `src/permaship/client.ts`, rewrite every call site to use local-only implementations, then try to maintain a separate fork for PermaShip. This creates two diverging codebases that are painful to keep in sync.

### The Right Approach

```
┌─────────────────────────────────────────────────────────┐
│                    OSS Core Package                      │
│                                                         │
│  Agent Engine ─── Intent Router ─── RBAC ─── Guardrails │
│  Personas ─── Knowledge Base ─── Conversation History   │
│  Nexus Scheduler ─── Idle Detection ─── Strategy Engine │
│  Task Management ─── Staleness Checker ─── Security     │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │            Adapter Interfaces (contracts)          │  │
│  │                                                   │  │
│  │  LLMProvider  │  CommunicationAdapter  │ Project  │  │
│  │  TicketTracker │ CommitProvider │ KnowledgeSource │  │
│  │  TenantResolver │ UsageSink                       │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │         Default Adapters (ship with core)         │  │
│  │                                                   │  │
│  │  GeminiProvider │ DiscordAdapter │ CLIAdapter     │  │
│  │  LocalTicketTracker │ LocalGitCommitProvider      │  │
│  │  FileKnowledgeSource │ SingleTenantResolver       │  │
│  │  ConsoleUsageSink                                 │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
            ▲                              ▲
            │                              │
   ┌────────┴────────┐          ┌─────────┴──────────┐
   │  OSS User's     │          │  PermaShip Private  │
   │  Custom Adapters │          │  Adapter Package    │
   │  (optional)     │          │                     │
   │  OllamaProvider │          │  PermaShipTickets   │
   │  SlackAdapter   │          │  CommsGateway       │
   │  GitHubTracker  │          │  PermaShipTenant    │
   │  LinearTracker  │          │  PermaShipUsage     │
   │  ...            │          │  PermaShipKBSync    │
   └─────────────────┘          │  PermaShipProjects  │
                                │  PermaShipCommits   │
                                └─────────────────────┘
```

**The principle:** The OSS core defines contracts. It ships with sensible defaults that work locally. PermaShip (and any other consumer) provides its own adapter implementations. The core never imports PermaShip-specific code. PermaShip never forks the core.

---

## 2. The Eight Interface Boundaries

Every place the current code calls an external service maps to one of eight interfaces. Here is every call site in the codebase, grouped by which interface it belongs to:

| Interface | Current Implementation | Call Sites (files) | Functions Used |
|---|---|---|---|
| **LLMProvider** | `src/gemini/client.ts` | executor, router, strategy, reflection, proposal-service, sanitizer, knowledge/service, knowledge/sync | `callGemini()`, `callGeminiWithTools()`, `embedText()` |
| **CommunicationAdapter** | `src/services/communication/gateway.ts` | bot/formatter, bot/interactions, bot/listener, server/index | `sendMessage()`, `addReaction()`, `renameThread()` |
| **ProjectRegistry** | `src/permaship/client.ts` | prompt-builder, idle/throttle, proposal-service, tools/cli, staleness/checker | `listProjects()`, `resolveProjectId()`, `resolveRepoKey()`, `resolveProjectSlug()` |
| **TicketTracker** | `src/permaship/client.ts` | executor, nexus/scheduler, server/index, staleness/checker | `createSuggestion()`, `acceptSuggestion()`, `dismissSuggestion()`, `createPermashipTicket()`, `listSuggestions()` |
| **CommitProvider** | `src/permaship/client.ts` | staleness/git-check, proposal-service | `fetchLatestCommit()`, `fetchCommitsSince()` |
| **KnowledgeSource** | `src/permaship/client.ts` | knowledge/sync | `fetchKnowledgeDocuments()` |
| **TenantResolver** | `src/services/tenant.ts` | bot/listener, prompt-builder, router/index, server/index | `getContext()`, `linkWorkspace()`, `setInternalChannel()`, `getOrgName()` |
| **UsageSink** | `src/telemetry/usage-reporter.ts` → `src/permaship/client.ts` | usage-reporter (which calls `reportUsage()`) | `reportUsage()` |

These eight interfaces are the **complete set** of contracts needed. Everything else in the codebase is already self-contained.

---

## 3. Interface 1: LLM Provider

### Contract

```typescript
// src/llm/types.ts
export type ModelTier = 'ROUTER' | 'AGENT' | 'WORK' | 'EMBEDDING';

export interface LLMProvider {
  /** Simple text generation */
  generateText(options: {
    model: ModelTier;
    systemInstruction?: string;
    contents: Content[];    // re-export the Google GenAI Content type shape
    orgId?: string;
  }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>;

  /** Text generation with function calling / tool use */
  generateWithTools(options: {
    model: ModelTier;
    systemInstruction?: string;
    contents: Content[];
    tools: FunctionDeclaration[];
    orgId?: string;
  }): Promise<{
    text: string | null;
    functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
    usage?: { inputTokens: number; outputTokens: number };
  }>;

  /** Embed text for vector search. Return null if not supported. */
  embedText(text: string): Promise<number[] | null>;
}
```

### Default: Gemini (existing code, wrapped)

`src/llm/gemini.ts` — wraps the existing `src/gemini/client.ts` logic.

### Additional Defaults to Ship

| Implementation | File | Notes |
|---|---|---|
| `OpenAIProvider` | `src/llm/openai.ts` | Covers GPT-4o, local Ollama, vLLM, LM Studio, llama.cpp — anything with an OpenAI-compatible API |
| `AnthropicProvider` | `src/llm/anthropic.ts` | Claude models via `@anthropic-ai/sdk` |
| `OllamaProvider` | `src/llm/ollama.ts` | Native Ollama SDK, zero API key needed |

The OpenAI-compatible provider is the most important for local use — Ollama, vLLM, and LM Studio all expose OpenAI-compatible endpoints.

### Embedding Fallback

Not all providers support embeddings. When `embedText()` returns `null`, the knowledge service already falls back to keyword search in `queryKnowledge()`. No change needed there.

### Call Sites to Update (8 files)

| File | Currently Imports | Change To |
|---|---|---|
| `src/agents/executor.ts` | `callGemini` from `../gemini/client` | `llm.generateText()` from registry |
| `src/router/index.ts` | `callGemini` from `../gemini/client` | `llm.generateText()` |
| `src/agents/strategy.ts` | `callGemini` from `../gemini/client` | `llm.generateText()` |
| `src/agents/reflection.ts` | `callGemini` from `../gemini/client` | `llm.generateText()` |
| `src/tools/proposal-service.ts` | `callGemini` from `../gemini/client` | `llm.generateText()` |
| `src/bot/sanitizer.ts` | `callGemini` from `../gemini/client` | `llm.generateText()` |
| `src/knowledge/service.ts` | `embedText` from `../gemini/client` | `llm.embedText()` |
| `src/knowledge/sync.ts` | `embedText` from `../gemini/client` | `llm.embedText()` |

### PermaShip Impact

None. PermaShip continues using `GeminiProvider`. The calls are identical — just routed through the interface now.

---

## 4. Interface 2: Communication Adapter

### Contract

```typescript
// src/adapters/communication/types.ts
export interface OutboundMessage {
  content?: string;
  embed_title?: string;
  embed_description?: string;
  embed_color?: number;
  components?: any[];       // buttons, action rows
}

export interface SendOptions {
  thread_id?: string;
  channel_id?: string;
  dm_user_id?: string;
  create_thread_title?: string;
  orgId?: string;
}

export interface CommunicationAdapter {
  sendMessage(message: OutboundMessage, options: SendOptions):
    Promise<{ success: boolean; message_id?: string; thread_id?: string; error?: string }>;

  addReaction(channelId: string, messageId: string, emoji: string, orgId?: string):
    Promise<{ success: boolean; error?: string }>;

  renameThread(threadId: string, name: string, orgId?: string):
    Promise<{ success: boolean; error?: string }>;
}
```

This is almost identical to the existing `CommunicationGateway` class signature — intentionally so.

### Default Implementations

| Implementation | Description |
|---|---|
| `DiscordDirectAdapter` | Uses `discord.js` client directly — no intermediary gateway. Connects via WebSocket, sends messages via `channel.send()`. |
| `CLIAdapter` | stdin/stdout for local terminal use. Prints messages, reads input. No accounts needed. |
| `SlackBoltAdapter` | Uses `@slack/bolt` with Socket Mode (no public URL needed for local dev). |

### PermaShip Implementation

```typescript
// @permaship/agents-adapters/src/comms-gateway.ts
// This IS the existing CommunicationGateway class, moved to the private package.
// Routes through comms.permaship.ai as it does today.
export class PermaShipCommsAdapter implements CommunicationAdapter { ... }
```

### Inbound Messages

The inbound side also needs abstraction. Currently messages arrive via webhook from the comms gateway. In OSS mode they arrive directly from discord.js or stdin.

```typescript
// src/adapters/inbound/types.ts
export interface InboundAdapter {
  /** Start listening for messages. Call handler for each one. */
  start(handler: (message: UnifiedMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
```

| Implementation | How it works |
|---|---|
| `WebhookInbound` (current flow) | Fastify server receives HMAC-signed webhooks. PermaShip uses this. |
| `DiscordDirectInbound` | discord.js `client.on('messageCreate', ...)` converts to UnifiedMessage |
| `CLIInbound` | readline on stdin, wraps input as UnifiedMessage |

### Call Sites to Update (4 files)

| File | Current Usage |
|---|---|
| `src/bot/formatter.ts` | `comms.sendMessage(...)` |
| `src/bot/interactions.ts` | `comms.sendMessage(...)`, `comms.renameThread(...)` |
| `src/bot/listener.ts` | `comms.addReaction(...)` |
| `src/server/index.ts` | `comms.renameThread(...)` |

All switch from `import { comms }` to `import { getCommsAdapter }` from the registry.

### PermaShip Impact

Zero. The `PermaShipCommsAdapter` is the existing `CommunicationGateway` class, moved to the private package. Same HTTP calls, same HMAC signing, same behavior.

---

## 5. Interface 3: Project Registry

### Contract

```typescript
// src/adapters/projects/types.ts
export interface Project {
  id: string;
  name: string;
  slug: string;
  repoKey?: string | null;
}

export interface ProjectRegistry {
  listProjects(orgId: string): Promise<Project[]>;
  resolveProjectId(nameOrSlug: string, orgId: string): Promise<string | undefined>;
  resolveRepoKey(projectId: string, orgId: string): Promise<string | undefined>;
  resolveProjectSlug(projectId: string, orgId: string): Promise<string | undefined>;
}
```

### Default: Local DB or Config File

```typescript
// src/adapters/projects/local.ts
export class LocalProjectRegistry implements ProjectRegistry {
  async listProjects(orgId: string): Promise<Project[]> {
    // Read from local `projects` table or config/projects.json
  }
  async resolveProjectId(nameOrSlug: string, orgId: string) {
    // Same fuzzy-match logic that's currently in client.ts, but against local data
  }
  // ...
}
```

### PermaShip Implementation

```typescript
// @permaship/agents-adapters/src/projects.ts
// This IS the existing listProjects/resolveProjectId/etc. from permaship/client.ts
export class PermaShipProjectRegistry implements ProjectRegistry {
  async listProjects(orgId: string) {
    // GET /api/internal/orgs/{orgId}/projects — same as today
  }
  // ...
}
```

### Call Sites (5 files)

`prompt-builder.ts`, `idle/throttle.ts`, `proposal-service.ts`, `tools/cli.ts`, `staleness/checker.ts`

---

## 6. Interface 4: Ticket Tracker

### Contract

```typescript
// src/adapters/tickets/types.ts
export interface CreateSuggestionInput {
  repoKey: string;
  title: string;
  kind: 'bug' | 'feature' | 'task';
  description: string;
  projectId: string;
  priority?: number;
  labels?: string[];
}

export interface TicketTracker {
  createSuggestion(orgId: string, input: CreateSuggestionInput):
    Promise<{ success: boolean; suggestionId?: string; error?: string }>;

  acceptSuggestion(orgId: string, projectId: string, suggestionId: string):
    Promise<{ success: boolean; ticketId?: string; error?: string }>;

  dismissSuggestion(orgId: string, projectId: string, suggestionId: string):
    Promise<{ success: boolean; error?: string }>;

  /** Atomic create + accept. Returns the ticket ID. */
  createTicket(input: CreateTicketInput):
    Promise<{ success: boolean; ticketId?: string; error?: string }>;

  listSuggestions(orgId: string, projectId: string, params?: { status?: string; repoKey?: string }):
    Promise<Suggestion[]>;
}
```

### Default: Local DB

```typescript
// src/adapters/tickets/local.ts
export class LocalTicketTracker implements TicketTracker {
  async createSuggestion(orgId, input) {
    // Insert into pending_actions with status 'pending'
    // Return the row ID as suggestionId
  }
  async acceptSuggestion(orgId, projectId, suggestionId) {
    // Update pending_actions status to 'approved'
    // Insert into tickets table
  }
  async dismissSuggestion(orgId, projectId, suggestionId) {
    // Update pending_actions status to 'rejected'
  }
  async createTicket(input) {
    // Insert directly into tickets table
  }
  async listSuggestions(orgId, projectId, params) {
    // Query pending_actions table
  }
}
```

This also enables optional external push targets (GitHub Issues, Linear, Jira) by composing adapters:

```typescript
class GitHubTicketTracker implements TicketTracker {
  constructor(private local: LocalTicketTracker, private github: Octokit) {}

  async createTicket(input) {
    const localResult = await this.local.createTicket(input);
    // Also create GitHub Issue
    const issue = await this.github.issues.create({ ... });
    // Store external_id and external_url back
    return { ...localResult, externalUrl: issue.html_url };
  }
}
```

### PermaShip Implementation

```typescript
// @permaship/agents-adapters/src/tickets.ts
// This IS the existing createSuggestion/acceptSuggestion/etc. from permaship/client.ts
export class PermaShipTicketTracker implements TicketTracker { ... }
```

### Call Sites (4 files)

`executor.ts`, `nexus/scheduler.ts`, `server/index.ts`, `staleness/checker.ts`

---

## 7. Interface 5: Commit Provider (VCS)

### Contract

```typescript
// src/adapters/vcs/types.ts
export interface CommitProvider {
  fetchLatestCommit(orgId: string, repoKey: string):
    Promise<{ sha: string; date: string } | null>;

  fetchCommitsSince(orgId: string, repoKey: string, since: string):
    Promise<Array<{ sha: string; files: string[] }> | null>;
}
```

### Default: Local Git

```typescript
// src/adapters/vcs/local-git.ts
import { execSync } from 'child_process';

export class LocalGitCommitProvider implements CommitProvider {
  constructor(private projectRegistry: ProjectRegistry) {}

  async fetchLatestCommit(orgId: string, repoKey: string) {
    const project = await this.projectRegistry.resolveRepoPath(repoKey, orgId);
    if (!project?.repoPath) return null;
    const out = execSync('git log -1 --format="%H %aI"', { cwd: project.repoPath });
    const [sha, date] = out.toString().trim().split(' ');
    return { sha, date };
  }

  async fetchCommitsSince(orgId: string, repoKey: string, since: string) {
    // git log --since="{since}" --format="%H" --name-only
  }
}
```

### PermaShip Implementation

```typescript
// @permaship/agents-adapters/src/vcs.ts
// This IS the existing fetchLatestCommit/fetchCommitsSince from permaship/client.ts
export class PermaShipCommitProvider implements CommitProvider { ... }
```

### Call Sites (2 files)

`staleness/git-check.ts`, `tools/proposal-service.ts`

---

## 8. Interface 6: Knowledge Source

### Contract

```typescript
// src/adapters/knowledge/types.ts
export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  version: number;
  updatedAt: string;
}

export interface KnowledgeSource {
  /** Fetch documents to sync into the local knowledge base. */
  fetchDocuments(orgId: string, projectId: string): Promise<KnowledgeDocument[]>;
}
```

### Default: File-Based

```typescript
// src/adapters/knowledge/file-source.ts
import { readdirSync, readFileSync } from 'fs';
import matter from 'gray-matter';

export class FileKnowledgeSource implements KnowledgeSource {
  constructor(private knowledgeDir: string = './knowledge') {}

  async fetchDocuments(orgId: string, projectId: string): Promise<KnowledgeDocument[]> {
    // Read .md files from knowledge/ directory
    // Parse frontmatter for title, version
    // Return as KnowledgeDocument[]
  }
}
```

### PermaShip Implementation

```typescript
// @permaship/agents-adapters/src/knowledge.ts
// This IS the existing fetchKnowledgeDocuments from permaship/client.ts
export class PermaShipKnowledgeSource implements KnowledgeSource {
  async fetchDocuments(orgId: string, projectId: string) {
    // GET /api/orgs/{orgId}/projects/{projectId}/knowledge — same as today
  }
}
```

### Call Sites (1 file)

`knowledge/sync.ts` — the sync service itself stays in the core but calls `knowledgeSource.fetchDocuments()` instead of the PermaShip client directly.

---

## 9. Interface 7: Tenant Resolver

### Contract

```typescript
// src/adapters/tenant/types.ts
export interface WorkspaceContext {
  orgId: string;
  orgName?: string;
  platform: 'discord' | 'slack' | 'cli';
  workspaceId: string;
  internalChannelId?: string;
}

export interface TenantResolver {
  getContext(platform: string, workspaceId: string): Promise<WorkspaceContext | null>;
  linkWorkspace(orgId: string, platform: string, workspaceId: string,
    activatedBy: string, channelId: string, orgName?: string):
    Promise<{ success: boolean; error?: string }>;
  setInternalChannel(platform: string, workspaceId: string, channelId: string):
    Promise<{ success: boolean }>;
  getOrgName(orgId: string): Promise<string>;
}
```

### Default: Single Tenant

```typescript
// src/adapters/tenant/single-tenant.ts
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

export class SingleTenantResolver implements TenantResolver {
  async getContext(platform: string, workspaceId: string) {
    return {
      orgId: process.env.ORG_ID || DEFAULT_ORG_ID,
      orgName: process.env.ORG_NAME || 'Local',
      platform: platform as any,
      workspaceId,
    };
  }
  async linkWorkspace() { return { success: true }; }
  async setInternalChannel() { return { success: true }; }
  async getOrgName() { return process.env.ORG_NAME || 'Local'; }
}
```

### PermaShip Implementation

```typescript
// @permaship/agents-adapters/src/tenant.ts
// This IS the existing tenantService with verifyActivationToken() + DB lookups
export class PermaShipTenantResolver implements TenantResolver { ... }
```

### Call Sites (4 files)

`bot/listener.ts`, `agents/prompt-builder.ts`, `router/index.ts`, `server/index.ts`

---

## 10. Interface 8: Usage Sink

### Contract

```typescript
// src/adapters/usage/types.ts
export interface UsagePayload {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  windowStartedAt: string;
}

export interface UsageSink {
  report(orgId: string, payload: UsagePayload): Promise<void>;
}
```

### Default: Console Log

```typescript
// src/adapters/usage/console.ts
export class ConsoleUsageSink implements UsageSink {
  async report(orgId: string, payload: UsagePayload) {
    logger.info({ orgId, ...payload }, 'Token usage');
  }
}
```

### PermaShip Implementation

```typescript
// @permaship/agents-adapters/src/usage.ts
// This IS the existing reportUsage() call to POST /api/internal/orgs/{orgId}/usage
export class PermaShipUsageSink implements UsageSink { ... }
```

### Call Sites (1 file)

`telemetry/usage-reporter.ts` — the `UsageReporter` class calls `usageSink.report()` instead of `reportUsage()` from the PermaShip client.

---

## 11. Repo Structure & Packaging

### Phase 1: Monorepo (During Transition)

While extracting interfaces, keep everything in one repo with a clear directory split:

```
agents/
├── src/                          # OSS Core
│   ├── adapters/                 # Interface definitions + default implementations
│   │   ├── llm/
│   │   │   ├── types.ts          # LLMProvider interface
│   │   │   ├── gemini.ts         # Default: Gemini (moved from src/gemini/)
│   │   │   ├── openai.ts         # Default: OpenAI-compatible
│   │   │   └── ollama.ts         # Default: Ollama native
│   │   ├── communication/
│   │   │   ├── types.ts          # CommunicationAdapter + InboundAdapter interfaces
│   │   │   ├── discord.ts        # Default: Direct discord.js
│   │   │   ├── cli.ts            # Default: Terminal stdin/stdout
│   │   │   └── webhook.ts        # Default: Fastify webhook receiver (also used by PermaShip)
│   │   ├── projects/
│   │   │   ├── types.ts          # ProjectRegistry interface
│   │   │   └── local.ts          # Default: Local DB / config file
│   │   ├── tickets/
│   │   │   ├── types.ts          # TicketTracker interface
│   │   │   └── local.ts          # Default: Local DB
│   │   ├── vcs/
│   │   │   ├── types.ts          # CommitProvider interface
│   │   │   └── local-git.ts      # Default: Local git commands
│   │   ├── knowledge/
│   │   │   ├── types.ts          # KnowledgeSource interface
│   │   │   └── file-source.ts    # Default: Read .md files from disk
│   │   ├── tenant/
│   │   │   ├── types.ts          # TenantResolver interface
│   │   │   └── single-tenant.ts  # Default: Single org, no activation
│   │   ├── usage/
│   │   │   ├── types.ts          # UsageSink interface
│   │   │   └── console.ts        # Default: Log to console
│   │   └── registry.ts           # Adapter registry (get/set active adapters)
│   ├── agents/                   # (unchanged) Agent engine
│   ├── bot/                      # (unchanged) Message formatting/interactions
│   ├── conversation/             # (unchanged) Conversation history
│   ├── core/                     # (unchanged) Guardrails, settings
│   ├── db/                       # (unchanged) Schema, migrations
│   ├── idle/                     # (unchanged) Idle detection
│   ├── intent/                   # (unchanged) Intent classification
│   ├── knowledge/                # (minor change) Service + sync use interfaces
│   ├── middleware/               # (unchanged) RBAC, channel safety
│   ├── nexus/                    # (minor change) Scheduler uses interfaces
│   ├── rbac/                     # (unchanged) Permission maps
│   ├── router/                   # (minor change) Uses LLMProvider interface
│   ├── security/                 # (unchanged) Security digest
│   ├── server/                   # (minor change) Uses adapter registry
│   ├── services/                 # (refactored) Tenant uses interface
│   ├── staleness/                # (minor change) Uses CommitProvider interface
│   ├── tasks/                    # (unchanged) Task service
│   ├── telemetry/                # (minor change) Uses UsageSink interface
│   ├── tools/                    # (minor change) Uses interfaces
│   ├── config.ts                 # Updated env schema
│   ├── index.ts                  # Startup wiring (loads adapters from config)
│   └── logger.ts                 # (unchanged)
├── personas/                     # (unchanged) Agent persona .md files
├── config/                       # (unchanged) Feature flags, kill switches
├── knowledge/                    # NEW: Default knowledge directory for file-based source
├── docs/                         # Updated documentation
├── package.json                  # OSS package
└── ...
```

The old `src/permaship/` directory and `src/services/communication/gateway.ts` get deleted from the OSS repo. Their code lives on in the PermaShip adapter package.

### Phase 2: Two Repos (After Stabilization)

Once the interfaces are stable:

**Repo 1: `github.com/yourorg/agents`** (public)
- The OSS core with all default adapters
- Published to npm as `@yourorg/agents` (or whatever the new name is)
- All issues, PRs, community contributions happen here

**Repo 2: `gitlab.com/permaship/agents-adapters`** (private)
- Thin package: `@permaship/agents-adapters`
- Depends on `@yourorg/agents`
- Contains only the 8 PermaShip adapter implementations + startup wiring
- Very small — under 1000 lines total

### Why Two Repos Instead of a Monorepo

- The OSS repo has **zero** PermaShip references — clean for the community
- PermaShip adapter code stays private and doesn't clutter the public repo
- Dependency direction is one-way: PermaShip depends on OSS, never the reverse
- Breaking interface changes are caught at compile time in the private repo

---

## 12. How PermaShip Consumes the OSS Core

### Package Structure

```json
// @permaship/agents-adapters/package.json
{
  "name": "@permaship/agents-adapters",
  "private": true,
  "dependencies": {
    "@yourorg/agents": "^1.0.0"
  }
}
```

### Entry Point

```typescript
// @permaship/agents-adapters/src/index.ts
import { createAgentSystem } from '@yourorg/agents';

// Import PermaShip adapter implementations
import { PermaShipCommsAdapter } from './comms-gateway.js';
import { PermaShipTicketTracker } from './tickets.js';
import { PermaShipProjectRegistry } from './projects.js';
import { PermaShipCommitProvider } from './vcs.js';
import { PermaShipKnowledgeSource } from './knowledge.js';
import { PermaShipTenantResolver } from './tenant.js';
import { PermaShipUsageSink } from './usage.js';
import { GeminiProvider } from '@yourorg/agents/adapters/llm/gemini';

// Wire everything up
const system = createAgentSystem({
  llm: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY }),
  communication: new PermaShipCommsAdapter({
    apiUrl: process.env.COMMS_API_URL,
    signingSecret: process.env.COMMS_SIGNING_SECRET,
  }),
  inbound: 'webhook',  // keep using the Fastify webhook receiver
  tickets: new PermaShipTicketTracker({
    apiUrl: process.env.PERMASHIP_API_URL,
    apiKey: process.env.PERMASHIP_API_KEY,
  }),
  projects: new PermaShipProjectRegistry({
    apiUrl: process.env.PERMASHIP_API_URL,
    apiKey: process.env.PERMASHIP_API_KEY,
  }),
  commits: new PermaShipCommitProvider({
    apiUrl: process.env.PERMASHIP_API_URL,
    apiKey: process.env.PERMASHIP_API_KEY,
  }),
  knowledge: new PermaShipKnowledgeSource({
    apiUrl: process.env.PERMASHIP_API_URL,
    apiKey: process.env.PERMASHIP_API_KEY,
  }),
  tenant: new PermaShipTenantResolver({
    apiUrl: process.env.PERMASHIP_API_URL,
    internalSecret: process.env.PERMASHIP_INTERNAL_SECRET,
  }),
  usage: new PermaShipUsageSink({
    apiUrl: process.env.PERMASHIP_API_URL,
    internalSecret: process.env.PERMASHIP_INTERNAL_SECRET,
  }),
});

system.start();
```

### What This Looks Like for PermaShip Day-to-Day

1. **OSS publishes a new version** with a new feature (e.g., better strategy sessions)
2. PermaShip runs `npm update @yourorg/agents`
3. TypeScript checks all 8 adapter implementations against the updated interfaces
4. If an interface changed, the compiler tells you exactly what to fix
5. If no interfaces changed (most updates), it just works
6. Deploy the PermaShip adapter package — same infra, same AWS, same everything

### What Happens If an Interface Changes

Say the `TicketTracker` interface adds a new method `updateTicket()`:

1. The OSS release notes document the breaking change
2. PermaShip bumps the dependency version
3. TypeScript compilation fails: `PermaShipTicketTracker is missing method updateTicket()`
4. Developer adds `updateTicket()` to the PermaShip adapter (calls existing API endpoint)
5. Done

This is a normal semver workflow. Breaking changes bump major versions.

---

## 13. Adapter Registry & Startup Wiring

### The Registry

```typescript
// src/adapters/registry.ts
import type { LLMProvider } from './llm/types.js';
import type { CommunicationAdapter } from './communication/types.js';
import type { ProjectRegistry } from './projects/types.js';
import type { TicketTracker } from './tickets/types.js';
import type { CommitProvider } from './vcs/types.js';
import type { KnowledgeSource } from './knowledge/types.js';
import type { TenantResolver } from './tenant/types.js';
import type { UsageSink } from './usage/types.js';

interface AdapterSet {
  llm: LLMProvider;
  communication: CommunicationAdapter;
  projects: ProjectRegistry;
  tickets: TicketTracker;
  commits: CommitProvider;
  knowledge: KnowledgeSource;
  tenant: TenantResolver;
  usage: UsageSink;
}

let adapters: AdapterSet;

export function registerAdapters(set: AdapterSet): void {
  adapters = set;
}

// Accessor functions used throughout the codebase
export function getLLM(): LLMProvider { return adapters.llm; }
export function getComms(): CommunicationAdapter { return adapters.communication; }
export function getProjects(): ProjectRegistry { return adapters.projects; }
export function getTickets(): TicketTracker { return adapters.tickets; }
export function getCommits(): CommitProvider { return adapters.commits; }
export function getKnowledge(): KnowledgeSource { return adapters.knowledge; }
export function getTenant(): TenantResolver { return adapters.tenant; }
export function getUsage(): UsageSink { return adapters.usage; }
```

### Default Startup (OSS)

```typescript
// src/index.ts
import { registerAdapters } from './adapters/registry.js';
import { GeminiProvider } from './adapters/llm/gemini.js';
import { OllamaProvider } from './adapters/llm/ollama.js';
import { DiscordDirectAdapter } from './adapters/communication/discord.js';
import { CLIAdapter } from './adapters/communication/cli.js';
import { LocalProjectRegistry } from './adapters/projects/local.js';
import { LocalTicketTracker } from './adapters/tickets/local.js';
import { LocalGitCommitProvider } from './adapters/vcs/local-git.js';
import { FileKnowledgeSource } from './adapters/knowledge/file-source.js';
import { SingleTenantResolver } from './adapters/tenant/single-tenant.js';
import { ConsoleUsageSink } from './adapters/usage/console.js';
import { config } from './config.js';

// Build adapter set from environment config
function buildDefaultAdapters(): AdapterSet {
  const llm = config.LLM_PROVIDER === 'gemini'
    ? new GeminiProvider(config.GEMINI_API_KEY)
    : new OllamaProvider(config.OLLAMA_BASE_URL);

  const communication = config.COMM_ADAPTER === 'discord'
    ? new DiscordDirectAdapter(config.DISCORD_BOT_TOKEN)
    : new CLIAdapter();

  return {
    llm,
    communication,
    projects: new LocalProjectRegistry(),
    tickets: new LocalTicketTracker(),
    commits: new LocalGitCommitProvider(),
    knowledge: new FileKnowledgeSource(),
    tenant: new SingleTenantResolver(),
    usage: new ConsoleUsageSink(),
  };
}

registerAdapters(buildDefaultAdapters());

// ... rest of startup (migrate, initializeAgents, startServer, etc.)
```

### Programmatic API (for PermaShip and Other Consumers)

```typescript
// src/system.ts — exported for consumers
export function createAgentSystem(adapters: Partial<AdapterSet> & Pick<AdapterSet, 'llm'>) {
  const defaults = buildDefaultAdapters();
  registerAdapters({ ...defaults, ...adapters });

  return {
    async start() {
      await migrate(db, { migrationsFolder: '...' });
      await initializeAgents();
      await startServer();
      startIdleTimer();
      // ... etc.
    },
    async stop() {
      await usageReporter.stop();
    },
  };
}
```

This is how PermaShip calls the core — `createAgentSystem()` with its adapter overrides. It doesn't need to fork or patch anything.

---

## 14. Configuration Strategy

### OSS `.env.example`

```env
# === LLM Provider ===
# Options: gemini, openai, anthropic, ollama
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
# GEMINI_API_KEY=          # if LLM_PROVIDER=gemini
# OPENAI_API_KEY=          # if LLM_PROVIDER=openai
# OPENAI_BASE_URL=         # for local OpenAI-compatible servers
# ANTHROPIC_API_KEY=       # if LLM_PROVIDER=anthropic

# Model overrides (optional — defaults vary by provider)
# LLM_MODEL_FAST=
# LLM_MODEL_STANDARD=
# LLM_MODEL_DEEP=
# LLM_MODEL_EMBEDDING=

# === Database ===
DATABASE_URL=postgres://agents:agents@localhost:5432/agents

# === Communication ===
# Options: discord, slack, cli
COMM_ADAPTER=cli
# DISCORD_BOT_TOKEN=       # if COMM_ADAPTER=discord
# DISCORD_CLIENT_ID=       # if COMM_ADAPTER=discord
# SLACK_BOT_TOKEN=         # if COMM_ADAPTER=slack
# SLACK_APP_TOKEN=         # if COMM_ADAPTER=slack (socket mode)

# === Organization ===
# ORG_NAME=My Team         # display name for your org

# === Optional ===
# LOG_LEVEL=info
# NODE_ENV=development
# IDLE_TIMEOUT_MS=1200000
# CTO_REVIEW_INTERVAL_MS=14400000
```

### PermaShip `.env` (unchanged from today)

```env
GEMINI_API_KEY=...
PERMASHIP_API_KEY=...
PERMASHIP_API_URL=...
PERMASHIP_ORG_ID=...
PERMASHIP_INTERNAL_SECRET=...
COMMS_API_URL=https://comms.permaship.ai
COMMS_SIGNING_SECRET=...
DATABASE_URL=...
```

PermaShip's env vars don't conflict with OSS env vars because PermaShip bypasses the default config — it passes adapter instances directly via `createAgentSystem()`.

### Config Schema

```typescript
// src/config.ts — updated for OSS
const envSchema = z.object({
  // Core (always required)
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info').transform(v => v.toLowerCase())
    .pipe(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])),

  // LLM Provider
  LLM_PROVIDER: z.enum(['gemini', 'openai', 'anthropic', 'ollama']).default('ollama'),
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),

  // Communication
  COMM_ADAPTER: z.enum(['discord', 'slack', 'cli']).default('cli'),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),

  // Organization
  ORG_NAME: z.string().default('Local'),

  // Timers (keep existing defaults)
  IDLE_TIMEOUT_MS: z.coerce.number().default(1_200_000),
  CTO_REVIEW_INTERVAL_MS: z.coerce.number().default(4 * 60 * 60 * 1000),
  CTO_DEBOUNCE_MS: z.coerce.number().default(2 * 60 * 1000),
  STALENESS_CHECK_INTERVAL_MS: z.coerce.number().default(7_200_000),
  STALENESS_DEFAULT_TTL_DAYS: z.coerce.number().default(7),
  STALENESS_MAX_REVALIDATIONS: z.coerce.number().default(3),
  SECURITY_DIGEST_INTERVAL_MS: z.coerce.number().default(7 * 24 * 60 * 60 * 1000),
  SECURITY_DIGEST_CHECK_INTERVAL_MS: z.coerce.number().default(3_600_000),
  USAGE_FLUSH_INTERVAL_MS: z.coerce.number().default(60_000),
  USAGE_FLUSH_TURN_THRESHOLD: z.coerce.number().default(100),
});
```

Note: The PermaShip-specific env vars (`PERMASHIP_*`, `COMMS_*`) are removed from the core config. The PermaShip adapter package defines its own config schema for those.

---

## 15. Database & Migrations

### What Stays the Same

The entire Drizzle schema and migration system stays in the OSS core. All tables keep their `org_id` columns for forward compatibility. Migrations auto-run on startup.

### Changes

| Change | Details |
|---|---|
| Rename table `permaship_tickets` → `tickets` | New migration. Rename `remoteTicketId` → `externalId`. Add `externalUrl` column. |
| Add `projects` table | `id`, `org_id`, `name`, `slug`, `repo_path`, `repo_remote_url`, `description` |
| Keep `workspace_links` | Still used for multi-tenant. `SingleTenantResolver` just doesn't need it. |

### PermaShip Impact

PermaShip runs the same migrations (they're in the core). The `tickets` rename is backwards-compatible — the PermaShip adapter just uses `externalId` where it previously used `remoteTicketId`.

---

## 16. What Stays in the OSS Core (Unchanged)

These components are already self-contained and need zero or trivial changes:

| Component | Directory | Notes |
|---|---|---|
| Agent Engine (personas, executor, coordinator) | `src/agents/` | Only change: import LLM from registry instead of directly |
| Intent Router | `src/router/`, `agents/router/` | Only change: import LLM from registry |
| RBAC System | `src/rbac/`, `src/middleware/` | Fully self-contained |
| Prompt Injection Detection | `src/core/guardrails/` | Fully self-contained |
| Circuit Breaker | `agents/router/circuit_breaker.ts` | Fully self-contained |
| Conversation History | `src/conversation/service.ts` | Local DB only |
| Knowledge Base CRUD | `src/knowledge/service.ts` | Local DB only |
| Task Management | `src/tasks/service.ts` | Local DB only |
| Activity Logging | `src/idle/activity.ts` | Local DB only |
| Settings Service | `src/settings/service.ts` | Local DB only |
| Secrets Service | `src/secrets/service.ts` | Local DB only |
| Bot Formatter | `src/bot/formatter.ts` | Only change: use comms adapter from registry |
| Bot Interactions | `src/bot/interactions.ts` | Only change: use comms adapter from registry |
| Idle Timer | `src/idle/timer.ts` | Minor: uses tenant from registry |
| Nexus Scheduler | `src/nexus/scheduler.ts` | Minor: uses ticket tracker from registry |
| Staleness Checker | `src/staleness/` | Minor: uses commit provider from registry |
| Security Digest | `src/security/scheduler.ts` | Minor: uses ticket tracker from registry |
| Agent Personas | `personas/*.md` | Minor: remove PermaShip-specific repo references |
| Database Schema | `src/db/schema.ts` | Minor: rename `permashipTickets` |
| Logger | `src/logger.ts` | Fully self-contained |

**Bottom line:** The core business logic — what makes this system valuable — is already decoupled. The interface extraction is purely a plumbing exercise at the edges.

---

## 17. Branding & Licensing

### Branding Cleanup

| Item | Current | OSS |
|---|---|---|
| Package name | `@permaship/agents` | New name (e.g., `@hiveops/core`) |
| `private` field | `true` | `false` |
| Log messages | "Starting PermaShip Agent System..." | "Starting Agent System..." |
| `mission.md` | PermaShip-specific | Generalize or remove |
| Persona files | Reference PermaShip repos | Use placeholder project names |
| `seed-knowledge.ts` | PermaShip project descriptions | Generic example content |
| Docker image | `permaship/agents` | New name |
| README | PermaShip-centric | OSS quick start + architecture |

~44 files reference "permaship" — most are find-and-replace after the `src/permaship/` directory moves to the private adapter package.

### License

| License | Trade-off |
|---|---|
| **Apache 2.0** | Enterprise-friendly, patent grant, allows proprietary use (recommended) |
| **MIT** | Maximum adoption, no patent protection |
| **AGPL 3.0** | Copyleft — forces contributions back, but scares enterprises |

Apache 2.0 is the sweet spot: it lets PermaShip use the core commercially (which it will) while providing patent protection for contributors.

---

## 18. Infrastructure & Deployment

### OSS: docker-compose.yml (Full Stack)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: agents
      POSTGRES_PASSWORD: agents
      POSTGRES_DB: agents
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  ollama:              # Optional: local LLM
    image: ollama/ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    profiles: ["local-llm"]

  agents:
    build: .
    env_file: .env
    ports:
      - "9000:9000"
    depends_on:
      - postgres
    environment:
      DATABASE_URL: postgres://agents:agents@postgres:5432/agents

volumes:
  pgdata:
  ollama_data:
```

### PermaShip: Unchanged

PermaShip keeps its existing AWS infrastructure (ECS, RDS, Secrets Manager, etc.). The Dockerfile changes minimally — it now builds the adapter package alongside the core. The `infra/` directory stays in the PermaShip repo (not in OSS).

| Current Location | OSS Location | PermaShip Location |
|---|---|---|
| `infra/` | Not included | Stays in PermaShip infra repo |
| `deploy-aws.sh` | Not included | Stays in PermaShip infra repo |
| `.gitlab-ci.yml` | Replaced by `.github/workflows/ci.yml` | PermaShip keeps its own CI |
| `Dockerfile` | Simplified (no PermaShip refs) | PermaShip has its own Dockerfile that builds adapter package |

---

## 19. Documentation

### New Docs for OSS

| Document | Purpose |
|---|---|
| `README.md` | Quick start, architecture overview, "clone → run in 2 minutes" |
| `docs/quickstart.md` | Docker and bare-metal setup guides |
| `docs/configuration.md` | All env vars, defaults, and what they do |
| `docs/llm-providers.md` | How to use Gemini, OpenAI, Anthropic, Ollama, local models |
| `docs/communication-adapters.md` | Discord, Slack, CLI setup |
| `docs/custom-adapters.md` | How to write your own adapter (the PermaShip integration is the reference example) |
| `docs/agents.md` | How personas work, how to create/modify agents |
| `docs/architecture.md` | System design, adapter pattern, data flow |
| `docs/contributing.md` | Dev setup, coding standards, PR process |
| `LICENSE` | Apache 2.0 |

### Existing Docs to Keep

| Document | Notes |
|---|---|
| `docs/security/intent-recognition-threat-model.md` | Valuable, keep as-is |
| `docs/security/red-teaming-playbook.md` | Valuable, keep as-is |
| `docs/user-guide.md` | Update to remove PermaShip references |

---

## 20. CI/CD

### OSS: GitHub Actions

```yaml
name: CI
on: [push, pull_request]
jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run format:check && npm run lint && npm run typecheck

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: agents, POSTGRES_PASSWORD: agents, POSTGRES_DB: agents_test }
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run test:run
        env:
          DATABASE_URL: postgres://agents:agents@localhost:5432/agents_test
          LLM_PROVIDER: ollama
```

### PermaShip: Keeps GitLab CI

PermaShip's CI builds the adapter package, runs its own integration tests against the PermaShip API staging environment, and deploys to ECS. Unchanged from today.

---

## 21. Migration Roadmap

### Phase 1: Extract Interfaces (Can Be Done Incrementally)

Each step is a single PR. The system works at every intermediate state because the PermaShip implementations still exist — they just move behind the interface.

| Step | What | Impact on PermaShip |
|---|---|---|
| 1a | Create `src/adapters/llm/types.ts`, wrap existing Gemini code as `GeminiProvider` | Zero — same code, new wrapper |
| 1b | Update all 8 files that import `gemini/client` to use `getLLM()` from registry | Zero — returns same Gemini provider |
| 1c | Create `src/adapters/communication/types.ts`, wrap existing gateway as default | Zero — same class, new interface |
| 1d | Update 4 files that import comms gateway to use `getComms()` from registry | Zero — returns same gateway |
| 1e | Create `src/adapters/projects/types.ts`, wrap existing PermaShip functions | Zero |
| 1f | Create `src/adapters/tickets/types.ts`, wrap existing PermaShip functions | Zero |
| 1g | Create `src/adapters/vcs/types.ts`, wrap existing PermaShip functions | Zero |
| 1h | Create `src/adapters/knowledge/types.ts`, wrap existing PermaShip functions | Zero |
| 1i | Create `src/adapters/tenant/types.ts`, wrap existing tenant service | Zero |
| 1j | Create `src/adapters/usage/types.ts`, wrap existing usage reporter | Zero |
| 1k | Create `src/adapters/registry.ts` and wire into `src/index.ts` | Zero |

**After Phase 1:** The system works identically to today. Every external call goes through an interface, but the implementations are the same PermaShip code. This can be deployed to production immediately.

### Phase 2: Add Default (Local) Implementations

| Step | What |
|---|---|
| 2a | `src/adapters/llm/ollama.ts` — Ollama native provider |
| 2b | `src/adapters/llm/openai.ts` — OpenAI-compatible provider |
| 2c | `src/adapters/communication/cli.ts` — Terminal adapter |
| 2d | `src/adapters/communication/discord.ts` — Direct discord.js adapter |
| 2e | `src/adapters/projects/local.ts` — Local DB/config project registry |
| 2f | `src/adapters/tickets/local.ts` — Local-only ticket tracker |
| 2g | `src/adapters/vcs/local-git.ts` — Local git commit provider |
| 2h | `src/adapters/knowledge/file-source.ts` — Read .md files from disk |
| 2i | `src/adapters/tenant/single-tenant.ts` — Single-org, no activation |
| 2j | `src/adapters/usage/console.ts` — Log to console |
| 2k | Update `src/config.ts` with new env schema (LLM_PROVIDER, COMM_ADAPTER, etc.) |
| 2l | Update `src/index.ts` to select adapters based on config |

**After Phase 2:** The system runs locally with `LLM_PROVIDER=ollama COMM_ADAPTER=cli npm run dev`. PermaShip still works because it overrides the defaults.

### Phase 3: Separate the Repos

| Step | What |
|---|---|
| 3a | Move PermaShip adapter implementations to `@permaship/agents-adapters` private package |
| 3b | Delete `src/permaship/` directory from the core repo |
| 3c | Delete `src/services/communication/gateway.ts` from the core repo |
| 3d | Remove PermaShip env vars from core `src/config.ts` |
| 3e | Branding cleanup — rename package, update all "permaship" references |
| 3f | Update persona files — replace PermaShip repo names with placeholders |
| 3g | Rewrite `seed-knowledge.ts` with generic example content |
| 3h | Add LICENSE file (Apache 2.0) |
| 3i | Rewrite README.md |
| 3j | Create all docs (quickstart, providers, adapters, contributing) |
| 3k | Set up GitHub Actions CI |
| 3l | Update docker-compose.yml for full-stack local use |
| 3m | Move `infra/` and `deploy-aws.sh` to PermaShip infra repo |
| 3n | Publish first OSS release |

### Phase 4: Enhancements (Post-Launch)

| Step | What |
|---|---|
| 4a | `src/adapters/communication/slack.ts` — Direct Slack Bolt adapter (Socket Mode) |
| 4b | `src/adapters/tickets/github.ts` — GitHub Issues integration |
| 4c | `src/adapters/llm/anthropic.ts` — Anthropic Claude provider |
| 4d | Simple web dashboard — approve/reject proposals, view activity |
| 4e | Plugin discovery — load adapters from node_modules dynamically |

---

## 22. File-by-File Change Index

### Move to PermaShip Private Package (After Phase 3)

| File | Becomes |
|---|---|
| `src/permaship/client.ts` | `@permaship/agents-adapters/src/tickets.ts`, `projects.ts`, `vcs.ts`, `knowledge.ts`, `usage.ts` (split by interface) |
| `src/services/communication/gateway.ts` | `@permaship/agents-adapters/src/comms-gateway.ts` |
| `src/services/tenant.ts` (PermaShip-specific parts) | `@permaship/agents-adapters/src/tenant.ts` |
| `infra/` | PermaShip infra repo |
| `deploy-aws.sh` | PermaShip infra repo |
| `.gitlab-ci.yml` | PermaShip repo only |

### New Files in OSS Core

| File | Purpose |
|---|---|
| `src/adapters/llm/types.ts` | LLMProvider interface |
| `src/adapters/llm/gemini.ts` | Default: Gemini (refactored from existing code) |
| `src/adapters/llm/openai.ts` | Default: OpenAI-compatible |
| `src/adapters/llm/ollama.ts` | Default: Ollama native |
| `src/adapters/llm/anthropic.ts` | Default: Anthropic |
| `src/adapters/communication/types.ts` | CommunicationAdapter + InboundAdapter interfaces |
| `src/adapters/communication/discord.ts` | Default: Direct discord.js |
| `src/adapters/communication/cli.ts` | Default: Terminal stdin/stdout |
| `src/adapters/communication/webhook.ts` | Default: Fastify webhook (used by PermaShip too) |
| `src/adapters/projects/types.ts` | ProjectRegistry interface |
| `src/adapters/projects/local.ts` | Default: Local DB |
| `src/adapters/tickets/types.ts` | TicketTracker interface |
| `src/adapters/tickets/local.ts` | Default: Local DB |
| `src/adapters/vcs/types.ts` | CommitProvider interface |
| `src/adapters/vcs/local-git.ts` | Default: Local git |
| `src/adapters/knowledge/types.ts` | KnowledgeSource interface |
| `src/adapters/knowledge/file-source.ts` | Default: Read from `knowledge/` dir |
| `src/adapters/tenant/types.ts` | TenantResolver interface |
| `src/adapters/tenant/single-tenant.ts` | Default: Single org |
| `src/adapters/usage/types.ts` | UsageSink interface |
| `src/adapters/usage/console.ts` | Default: Log to console |
| `src/adapters/registry.ts` | Get/set active adapters |
| `src/system.ts` | `createAgentSystem()` programmatic API |
| `LICENSE` | Apache 2.0 |
| `.github/workflows/ci.yml` | GitHub Actions CI |

### Modified Files in OSS Core

| File | Change |
|---|---|
| `src/agents/executor.ts` | Import LLM + tickets from registry instead of directly |
| `src/agents/prompt-builder.ts` | Import projects + tenant from registry |
| `src/agents/strategy.ts` | Import LLM from registry |
| `src/agents/reflection.ts` | Import LLM from registry |
| `src/router/index.ts` | Import LLM + tenant from registry |
| `src/bot/formatter.ts` | Import comms from registry |
| `src/bot/interactions.ts` | Import comms from registry |
| `src/bot/listener.ts` | Import comms + tenant from registry |
| `src/bot/sanitizer.ts` | Import LLM from registry |
| `src/server/index.ts` | Import comms + tickets from registry |
| `src/tools/proposal-service.ts` | Import LLM + projects + commits from registry |
| `src/tools/cli.ts` | Import projects from registry |
| `src/nexus/scheduler.ts` | Import tickets from registry |
| `src/staleness/checker.ts` | Import projects + tickets from registry |
| `src/staleness/git-check.ts` | Import commits from registry |
| `src/knowledge/service.ts` | Import LLM from registry (for embeddings) |
| `src/knowledge/sync.ts` | Import knowledge source + LLM from registry |
| `src/idle/throttle.ts` | Import projects + tickets from registry |
| `src/telemetry/usage-reporter.ts` | Import usage sink from registry |
| `src/config.ts` | New schema (remove PERMASHIP_*, add LLM_PROVIDER, COMM_ADAPTER) |
| `src/index.ts` | Wire default adapters from config |
| `src/db/schema.ts` | Rename `permashipTickets` → `tickets` |
| `package.json` | Rename, set `private: false`, add optional deps |
| `docker-compose.yml` | Full stack (postgres + optional ollama) |
| `README.md` | Complete rewrite for OSS |
| `personas/*.md` | Remove PermaShip-specific repo references |
| `src/seed-knowledge.ts` | Generic example content |

### Unchanged (No Modification Needed)

| File/Directory | Reason |
|---|---|
| `src/core/guardrails/` | Self-contained security |
| `src/rbac/`, `src/middleware/` | Self-contained RBAC |
| `src/conversation/service.ts` | Local DB only |
| `src/tasks/service.ts` | Local DB only |
| `src/idle/activity.ts` | Local DB only |
| `src/settings/service.ts` | Local DB only |
| `src/secrets/service.ts` | Local DB only |
| `agents/router/` | Intent system — provider-agnostic |
| `agents/schemas/` | Zod schemas — standalone |
| `docs/security/` | Security docs — keep |
| `src/logger.ts` | Self-contained |
| `Dockerfile` | Minor comment cleanup only |
| `src/db/migrations/` | All existing migrations stay |

---

## 23. Risk & Compatibility

### Interface Stability

The biggest risk is interface churn — if the 8 interfaces change frequently, PermaShip has to chase updates. Mitigation:

1. **Design interfaces from the actual call sites.** The interfaces above are derived from how the code actually uses these services today — they're not hypothetical. This minimizes the chance of needing changes.

2. **Semantic versioning.** Interface changes bump the major version. PermaShip pins to a major version range and upgrades deliberately.

3. **Additive changes are safe.** Adding optional methods (with defaults) doesn't break existing adapters. Only removing or changing method signatures is breaking.

### Testing the Contract

Add interface compliance tests:

```typescript
// src/adapters/tickets/__tests__/contract.test.ts
import { TicketTracker } from '../types.js';

export function testTicketTrackerContract(createTracker: () => TicketTracker) {
  it('creates a suggestion and accepts it', async () => { ... });
  it('dismisses a suggestion', async () => { ... });
  it('lists suggestions with status filter', async () => { ... });
}
```

Both `LocalTicketTracker` and `PermaShipTicketTracker` run the same contract tests, ensuring behavioral compatibility.

### Migration Risk

Phase 1 has **zero risk** — it's purely structural refactoring. The PermaShip implementations stay exactly as they are, just moved behind interfaces. Every step can be deployed to production and rolled back if needed.

Phase 2 adds new code (default adapters) but doesn't change existing behavior.

Phase 3 (repo split) is the only step that requires coordination — but by that point the interfaces are proven in production.

### What Could Break

| Scenario | Mitigation |
|---|---|
| OSS adds a new required interface method | Semver major bump. PermaShip CI catches at compile time. |
| OSS changes database schema | Migrations are in the core — PermaShip runs them automatically. |
| OSS removes a feature PermaShip depends on | Unlikely if core is well-scoped. PermaShip can pin to a specific version. |
| Community PR changes adapter contract | Code review on interface changes requires explicit approval. |

---

## Summary

The core insight is that this codebase is **already nearly modular** — it just hardcodes which implementations to use. The work is:

1. Define 8 TypeScript interfaces (derived from actual call sites — no guesswork)
2. Wrap the existing PermaShip code behind those interfaces (zero behavior change)
3. Add local-only default implementations alongside them
4. Make startup configurable (which adapters to load)
5. Split the repos when ready

PermaShip continues running the exact same code it runs today. The OSS community gets a system that works with `docker compose up`. And as either side improves, the other benefits — because they share the same core, connected by typed contracts.
