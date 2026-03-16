# Plan: Local Code Execution Backends

## Goal

When a ticket is approved, instead of only sending it to the PermaShip API (where PermaShip's own runners execute it), allow dispatching to a locally running coding agent — Gemini CLI, Claude Code, Codex CLI, or OpenClaw — that directly makes code changes in a local repo.

## Current Flow (PermaShip-only)

```
Agent proposes ticket
    → Nexus approves
    → Human approves (or autonomous)
    → createPermashipTicket() calls PermaShip API
    → PermaShip backend spawns a runner, makes code changes, opens PR
```

The agents system **proposes** work. It does not **execute** code. Execution is delegated to a remote service via the TicketTracker adapter.

## New Flow (Local execution option)

```
Agent proposes ticket
    → Nexus approves
    → Human approves (or autonomous)
    → TicketTracker.createTicket() dispatches based on config:
        Option A: PermaShip API (existing)
        Option B: Spawn local CLI (Gemini CLI, Claude Code, Codex, OpenClaw)
        Option C: Local DB only (no execution — just track the ticket)
```

## Architecture

This is a new **TicketTracker** adapter implementation. The interface already supports everything we need:

```typescript
interface TicketTracker {
  createSuggestion(orgId, input): Promise<{ success, suggestionId?, error? }>;
  acceptSuggestion(orgId, projectId, suggestionId): Promise<{ success, ticketId?, error? }>;
  dismissSuggestion(orgId, projectId, suggestionId): Promise<{ success, error? }>;
  createTicket(input: CreateTicketInput): Promise<{ success, ticketId?, error? }>;
  listSuggestions(orgId, projectId, params?): Promise<PermashipSuggestion[]>;
}
```

The critical method is `createTicket()`. Currently it calls the PermaShip API. The new implementation will:
1. Store the ticket locally (same as now)
2. Dispatch execution to a configured backend

---

## New Files

```
src/adapters/local/
  ticket-tracker.ts       # LocalTicketTracker — DB storage + execution dispatch
  execution-backends/
    index.ts              # Backend registry + types
    gemini-cli.ts         # Spawns `gemini` CLI
    claude-code.ts        # Spawns `claude` CLI
    codex-cli.ts          # Spawns `codex` CLI
    openclaw.ts           # Spawns `openclaw` CLI
    noop.ts               # No execution — just stores ticket
```

## Execution Backend Interface

```typescript
// src/adapters/local/execution-backends/index.ts

export interface ExecutionResult {
  success: boolean;
  branch?: string;       // git branch with changes
  commitSha?: string;    // resulting commit
  output?: string;       // CLI stdout
  error?: string;
}

export interface ExecutionBackend {
  name: string;
  execute(ticket: TicketSpec): Promise<ExecutionResult>;
}

export interface TicketSpec {
  ticketId: string;
  kind: 'bug' | 'feature' | 'task';
  title: string;
  description: string;
  repoPath: string;      // local filesystem path to the repo
  repoKey: string;       // project identifier
  branch?: string;       // base branch (default: main)
}
```

## Backend Implementations

### Gemini CLI

```typescript
// Spawns: gemini -p "Fix bug: <title>\n\n<description>" --cwd <repoPath>
export class GeminiCliBackend implements ExecutionBackend {
  name = 'gemini-cli';
  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const prompt = buildPrompt(ticket);
    const child = spawn('gemini', ['-p', prompt, '--cwd', ticket.repoPath]);
    // ... capture stdout, wait for exit, return result
  }
}
```

### Claude Code

```typescript
// Spawns: claude -p "Fix bug: <title>\n\n<description>" --cwd <repoPath>
export class ClaudeCodeBackend implements ExecutionBackend {
  name = 'claude-code';
  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const prompt = buildPrompt(ticket);
    const child = spawn('claude', ['-p', prompt, '--cwd', ticket.repoPath]);
    // ... capture stdout, wait for exit, return result
  }
}
```

### Codex CLI

```typescript
// Spawns: codex -p "Fix bug: <title>\n\n<description>" --cwd <repoPath>
export class CodexCliBackend implements ExecutionBackend {
  name = 'codex-cli';
  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const prompt = buildPrompt(ticket);
    const child = spawn('codex', ['-p', prompt, '--cwd', ticket.repoPath]);
    // ... capture stdout, wait for exit, return result
  }
}
```

### OpenClaw

```typescript
// Spawns: openclaw run --task "<prompt>" --repo <repoPath>
export class OpenClawBackend implements ExecutionBackend {
  name = 'openclaw';
  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const prompt = buildPrompt(ticket);
    const child = spawn('openclaw', ['run', '--task', prompt, '--repo', ticket.repoPath]);
    // ... capture stdout, wait for exit, return result
  }
}
```

### No-op (local tracking only)

```typescript
export class NoopBackend implements ExecutionBackend {
  name = 'noop';
  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    return { success: true }; // ticket is already stored in DB
  }
}
```

## LocalTicketTracker

```typescript
// src/adapters/local/ticket-tracker.ts

export class LocalTicketTracker implements TicketTracker {
  constructor(
    private backend: ExecutionBackend,
    private repoRoot: string,   // base path for repos
  ) {}

  async createTicket(input: CreateTicketInput): Promise<{ success; ticketId?; error? }> {
    // 1. Store ticket locally in DB (same as permaship impl)
    const ticketId = await this.storeTicket(input);

    // 2. Dispatch to execution backend
    const result = await this.backend.execute({
      ticketId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      repoPath: path.join(this.repoRoot, input.repoKey),
      repoKey: input.repoKey,
    });

    // 3. Update ticket with execution result
    if (result.success) {
      await this.updateTicketStatus(ticketId, 'executing', result);
    }

    return { success: true, ticketId };
  }

  // Suggestions are local-only (stored in pendingActions, no remote API)
  async createSuggestion(orgId, input) { /* insert to DB, return local ID */ }
  async acceptSuggestion(orgId, projectId, suggestionId) { /* update status in DB */ }
  async dismissSuggestion(orgId, projectId, suggestionId) { /* update status in DB */ }
  async listSuggestions(orgId, projectId, params?) { /* query DB */ }
}
```

## Configuration

```bash
# .env
EXECUTION_BACKEND=claude-code    # gemini-cli | claude-code | codex-cli | openclaw | noop
REPO_ROOT=/home/user/projects    # base path — ticket repoKey is appended
EXECUTION_TIMEOUT_MS=600000      # 10 minute timeout for CLI execution
```

Backend selection in adapter wiring:

```typescript
function createExecutionBackend(): ExecutionBackend {
  switch (process.env.EXECUTION_BACKEND) {
    case 'gemini-cli':  return new GeminiCliBackend();
    case 'claude-code': return new ClaudeCodeBackend();
    case 'codex-cli':   return new CodexCliBackend();
    case 'openclaw':    return new OpenClawBackend();
    default:            return new NoopBackend();
  }
}
```

## Prompt Construction

All backends receive a structured prompt built from the ticket:

```typescript
function buildPrompt(ticket: TicketSpec): string {
  return `You are working on the "${ticket.repoKey}" repository.

## Task: ${ticket.title}
Type: ${ticket.kind}

## Description
${ticket.description}

## Instructions
- Create a new git branch for this work
- Make the necessary code changes
- Commit with a descriptive message
- Do not push (local changes only)`;
}
```

## Execution Lifecycle

```
1. Ticket approved
2. LocalTicketTracker.createTicket() called
3. Ticket stored in DB with status 'created'
4. ExecutionBackend.execute() spawned
5. CLI runs in the target repo directory
6. On completion: ticket status → 'completed' or 'failed'
7. CommunicationAdapter notifies the channel with result
```

## Database Changes

Add columns to `permaship_tickets` (or new `tickets` table after OSS rename):

```sql
ALTER TABLE permaship_tickets ADD COLUMN execution_status text DEFAULT 'pending';
ALTER TABLE permaship_tickets ADD COLUMN execution_backend text;
ALTER TABLE permaship_tickets ADD COLUMN execution_branch text;
ALTER TABLE permaship_tickets ADD COLUMN execution_output text;
ALTER TABLE permaship_tickets ADD COLUMN executed_at timestamp;
```

## Open Questions

- Should execution be synchronous (block until CLI finishes) or async (background job with status polling)?
- Should we create a git branch before spawning the CLI, or let the CLI manage branching?
- Should execution results be reported back to the agent for follow-up analysis?
- Max concurrency: should we limit to 1 execution at a time, or allow parallel?
- Should the execution prompt include context from the knowledge base?

## Estimated Scope

- ~200 lines: LocalTicketTracker
- ~50 lines per backend (5 backends = ~250 lines)
- ~80 lines: backend registry, types, prompt builder
- ~30 lines: DB migration
- ~50 lines: config + wiring
