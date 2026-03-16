# CLAUDE.md — AI-Assisted Setup Guide

This file helps AI coding assistants (Claude Code, Cursor, Copilot, etc.) understand how to set up and work with this project.

## IMPORTANT: How to Start This Project

```bash
npm install
npm run dev
```

That's it. **Do NOT start Docker or PostgreSQL.** Do NOT set DISCORD_BOT_TOKEN. Do NOT manually create a `.env` file.

The `npm run dev` command:
1. Prompts in the terminal for your LLM provider + API key (first run only)
2. Saves the key to `.env` automatically
3. Uses an embedded database (PGlite) — no Postgres needed
4. Starts a web UI at http://localhost:3000

If the user already has a `.env` with `LLM_API_KEY` or `GEMINI_API_KEY`, the prompt is skipped.

## What This Is

Nexus Command is a multi-agent AI system with 10 specialist agents (CISO, SRE, QA Manager, etc.) that collaborate on software development. It runs locally in a browser at http://localhost:3000.

## Environment Variables

Only needed if you want to override defaults. The system works with zero env vars (it will prompt for the API key).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | Yes (prompted) | - | API key for your LLM provider |
| `LLM_PROVIDER` | No | `gemini` | `gemini`, `anthropic`, `openai`, `ollama`, `openrouter` |
| `DATABASE_URL` | No | embedded PGlite | PostgreSQL connection string (overrides embedded DB) |
| `EXECUTION_BACKEND` | No | `noop` | `claude-code`, `gemini-cli`, `codex-cli`, `openclaw`, `permaship` |
| `LOCAL_UI_PORT` | No | `3000` | Port for the web UI |
| `LOG_LEVEL` | No | `info` | `debug` for verbose output |

**Do NOT set or require:** `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `COMMS_SIGNING_SECRET`, `PERMASHIP_API_KEY`, or any PermaShip-specific variables. These are only for the PermaShip deployment profile, not for local development.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | **Start the local UI** (this is the main command) |
| `npm start` | Same as `npm run dev` |
| `npm run dev:server` | Start the webhook server (Discord/Slack mode — requires additional config) |
| `npm run build` | Compile TypeScript |
| `npm run typecheck` | Type checking |
| `npm run test:run` | Run tests |

## Project Structure

```
bin/cli.ts            Entry point for npm run dev (interactive setup + local server)
src/local/            Local UI mode (server, adapters, execution backends)
src/adapters/         Adapter interfaces and implementations
  interfaces/         8 contracts (LLM, comms, projects, tickets, etc.)
  providers/          LLM providers (Anthropic, OpenAI, Ollama, Gemini)
  default/            Default adapters for standalone mode
src/agents/           Agent engine, executor, router, strategy
src/bot/              Message handling and formatting
src/db/               Database schema and migrations (Drizzle ORM)
personas/             Agent persona definitions (markdown)
ui/                   Browser chat interface (HTML/JS/CSS)
```

## Key Files

- `bin/cli.ts` — Entry point (interactive setup wizard + starts local server)
- `src/local/index.ts` — Local mode startup (adapter wiring, migrations, server)
- `src/local/server.ts` — Fastify server with WebSocket, REST API, static file serving
- `src/adapters/registry.ts` — Adapter registry with getter functions
- `src/agents/executor.ts` — Agent execution (fast API path and CLI path)
- `src/agents/prompt-builder.ts` — Builds context prompts for agents
- `src/bot/listener.ts` — Message processing pipeline

## Common Tasks

### Change the LLM provider
Set in `.env`:
```
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-...
```
Or change it live in the browser Settings panel.

### Connect a repository
Use the "+ Add Project" button in the browser UI sidebar.

### Enable code execution
Set `EXECUTION_BACKEND=claude-code` in `.env` (or select it in Settings).

## Troubleshooting

- **Port 3000 in use**: Set `LOCAL_UI_PORT=3001` in `.env`
- **API errors in chat**: Set `LOG_LEVEL=debug` in `.env` and check terminal output
- **Missing agents**: Check `personas/` directory has `.md` files
- **Database issues**: Delete `./data/pglite/` to reset
