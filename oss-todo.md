# OSS Extraction Checklist

Phase 1 (adapter interfaces) is complete. Phase 2 (OSS extraction) is largely complete.
This tracks the remaining work and what has been done.

---

## 1. Move to private `@permaship/agents-adapters` package

PermaShip adapter code remains in the repo for now (it must continue working), but is isolated
behind the adapter loader (`src/adapters/loader.ts`). These files should eventually be extracted
to a separate `@permaship/agents-adapters` package:

- [ ] `src/adapters/permaship/` (all 8 implementation files + config.ts)
- [ ] `src/permaship/client.ts` (raw PermaShip API client)
- [ ] `src/services/communication/gateway.ts` (PermaShip Comms gateway)
- [ ] `src/services/tenant.ts` (workspace/org linking + `verifyActivationToken`)
- [ ] `src/gemini/client.ts` + `src/gemini/models.ts` (Gemini-specific LLM client)
- [ ] `src/idle/backoff.ts` (dynamic import of permaship client — make fully adapter-based)

The following have been completed:
- [x] `initAdapters()` wiring — replaced with `loadAdapters()` in both `src/index.ts` and `src/tools/cli.ts`
- [x] `src/seed-knowledge.ts` — moved to `deploy/permaship/`
- [x] PermaShip service files now import from `src/adapters/permaship/config.ts` instead of core config

## 2. Move to PermaShip deployment config (not in OSS repo)

- [x] `infra/` → `deploy/permaship/infra/`
- [x] `deploy-aws.sh` → `deploy/permaship/deploy-aws.sh`
- [x] `Dockerfile.agents` → `deploy/permaship/Dockerfile.agents`
- [x] `.env.example` — replaced with generic version
- [x] `scripts/find-voltaire-org.ts` → `deploy/permaship/`
- [x] `scripts/check-internal-projects.ts` → `deploy/permaship/`

## 3. Make generic in OSS core

### `src/config.ts`
- [x] Removed `PERMASHIP_API_KEY`, `PERMASHIP_API_URL`, `PERMASHIP_ORG_ID`, `PERMASHIP_PROJECT_ID` from core schema
- [x] Replaced with generic vars: `INTERNAL_SECRET`, `WEBHOOK_SIGNING_SECRET`, `ACTIVATION_URL`, `LLM_API_KEY`
- [x] Added `ADAPTER_PROFILE` env var for adapter selection
- [x] Backward-compat fallbacks read from `process.env.PERMASHIP_*` for smooth migration

### `src/tools/proposal-service.ts`
- [x] Removed hardcoded repo name fallback heuristics
- [x] Uses only `resolveProjectSlug` as fallback

### `src/security/scheduler.ts`
- [x] Removed hardcoded `claude-conductor` and `permaship-comms` from digest prompt
- [x] Uses generic "all registered project repositories" phrasing

### `src/agents/prompt-builder.ts` + `src/agents/executor.ts`
- [x] Replaced `/home/yo/PycharmProjects/permaship` with `WORKSPACE_ROOT` env var (default `process.cwd()`)

### `src/bot/listener.ts`
- [x] Removed `@PermaShip` mention check
- [x] Made activation URL configurable via `ACTIVATION_URL` env var
- [x] Made welcome message generic

### Database schema
- [x] Renamed `permaship_tickets` table → `tickets` (with deprecated alias)
- [x] Added `Ticket` / `NewTicket` types (with deprecated aliases)
- [x] Renamed indexes in schema
- [x] Added migration `0013_rename_permaship_tickets.sql`

### Package identity
- [x] Renamed `@permaship/agents` → `agent-system` in `package.json`

### Persona file
- [x] `personas/ai-agent-sre.md` — removed `claude-conductor` from report template example

### Prompt builder
- [x] Removed `https://app.permaship.com` URL from browse tool example
- [x] Renamed `PERMASHIP_PASSWORD` to `APP_PASSWORD` in secret example

### Comments and strings
- [x] `src/server/index.ts` — updated all comments
- [x] `src/server/internal-chat-routes.ts` — updated comment
- [x] `Dockerfile` — already generic (no PermaShip reference)

### RBAC and Auth
- [x] Renamed `PermaShipRole` → `Role` (with deprecated alias)
- [x] Renamed `permashipRole` → `role` in request context
- [x] Renamed `permashipUserId` → `userId` in auth/token system
- [x] Updated all integration handlers, tests, and OAuth routes

### Other
- [x] `src/intent/classifier.ts` — removed "PermaShip" from system prompt
- [x] `src/tools/browser.ts` — made login flow generic (removed permaship.com check)
- [x] `src/middleware/rbac/admin.ts` — uses generic env vars with fallbacks

## 4. Write default OSS adapters

- [x] `LLMProvider` — `DefaultLLMProvider` (Gemini via `@google/genai` + `LLM_API_KEY`)
- [x] `CommunicationAdapter` — `ConsoleCommunicationAdapter` (stdout logging)
- [x] `ProjectRegistry` — `LocalProjectRegistry` (reads `projects.json`)
- [x] `TicketTracker` — `LocalTicketTracker` (in-memory)
- [x] `CommitProvider` — `GitCommitProvider` (local `git log`)
- [x] `KnowledgeSource` — `FileKnowledgeSource` (local markdown files)
- [x] `TenantResolver` — `SingleTenantResolver` (fixed org, DB-backed workspace links)
- [x] `UsageSink` — `ConsoleUsageSink` (stdout logging)
- [x] `src/adapters/loader.ts` — configurable adapter loading via `ADAPTER_PROFILE` env var

## 5. Documentation

- [x] Rewrite `README.md` — generic setup, adapter documentation, project structure
- [x] Add `CONTRIBUTING.md`
- [x] Add `LICENSE` (Apache-2.0)
- [x] Add `.env.example` with generic variable names
- [ ] Write adapter authoring guide (detailed how-to for each interface)
- [ ] Update `oss.md` to reflect completed work

## 6. Verification

- [x] `grep -ri "permaship" personas/` returns nothing
- [x] `npm run typecheck` passes
- [x] `npm run test:run` passes (33 files, 295 tests)
- [ ] `grep -ri "permaship" src/ --include="*.ts"` — remaining refs are in adapter code, deprecated aliases, and backward-compat env var fallbacks (expected until adapter extraction)
- [ ] Docker build succeeds with only OSS default adapters
- [ ] System starts and responds to a message using only default adapters
