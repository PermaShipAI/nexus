<p align="center">
  <img src="https://nexus.permaship.ai/agents-in-action.gif" alt="Nexus Command — AI team for your codebase" width="720" />
</p>

<p align="center">
  <a href="#getting-started"><strong>Quickstart</strong></a> &middot;
  <a href="https://discord.gg/JMMMT9EDVq"><strong>Discord</strong></a> &middot;
  <a href="CLAUDE.md"><strong>AI Setup Guide</strong></a>
</p>

<p align="center">
  <a href="https://discord.gg/JMMMT9EDVq"><img src="https://img.shields.io/discord/1468008322144800944?color=5865F2&logo=discord&logoColor=white&label=Discord" alt="Discord" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <a href="https://github.com/PermaShipAI/nexus/stargazers"><img src="https://img.shields.io/github/stars/PermaShipAI/nexus?style=flat" alt="Stars" /></a>
  <a href="https://img.shields.io/badge/PRs-welcome-brightgreen.svg"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
</p>

<br/>

# Nexus Command

An open-source multi-agent AI system that adds judgement, verification, and initiative to AI-assisted software development.

Most AI coding tools wait for you to ask. Nexus Command runs a team of specialized agents that proactively analyze your codebase, propose improvements, review each other's work, verify outcomes, and execute approved changes — with a human in the loop at every decision point. When work is executed by Claude Code, Codex, or any other coding agent, the team reviews the output before it ships.

Built by [PermaShip](https://permaship.ai) and used in production to run PermaShip's own engineering operations.

<br/>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center">Claude Code</td>
    <td align="center">Gemini CLI</td>
    <td align="center">Codex</td>
    <td align="center">OpenClaw</td>
    <td align="center">Ollama</td>
    <td align="center">Discord</td>
    <td align="center">Slack</td>
  </tr>
</table>
</div>

<br/>

## Nexus Command is right for you if

- You want AI that **takes initiative** — proactively analyzing code, surfacing issues, and driving work forward on a heartbeat
- You want **AI reviewing AI** — when a coding agent makes changes, specialist agents review the output before it reaches you
- You want **human-in-the-loop** with approve/reject on every proposal (or go fully autonomous)
- You want **goal-driven missions** — define an objective, and agents break it into checklist items, work through them, and verify completion
- You want to use **any LLM** — Gemini, Claude, GPT, Ollama, or mix and match
- You want agents that **remember context** across conversations and build knowledge over time
- You want approved tickets to be **automatically executed** by Claude Code, Codex, OpenClaw, or other coding agents

<br/>

## Getting Started

> **AI coding assistants:** Read [CLAUDE.md](CLAUDE.md) for setup instructions. Run `npm install && npm run dev` — do not start Docker or set Discord tokens.

```bash
npx nexus-command
```

Or clone and run locally:

```bash
git clone <repo-url> nexus-command
cd nexus-command
npm install
npm run dev
```

Open **http://localhost:3000**. That's it — no Docker, no Postgres, no manual config.

The interactive wizard prompts for your LLM API key on first run. The embedded database requires zero setup. See [QUICKSTART.md](QUICKSTART.md) for full setup guide.

<br/>

## Features

<table>
<tr>
<td width="33%">

### Browser Chat UI
Full-featured web interface with real-time WebSocket, dark/light theme, message search, project management, knowledge base editor, agent settings, and proposal approve/reject with undo.

</td>
<td width="33%">

### Multi-LLM Support
Google Gemini, Anthropic Claude, OpenAI, Ollama (local/free), or OpenRouter. Mix providers per tier — cheap model for routing, smart model for agents.

</td>
<td width="33%">

### Execution Backends
Approved tickets dispatch to Claude Code, Gemini CLI, Codex CLI, OpenClaw, or [PermaShip](https://permaship.ai/pricing). Git diff captured, agent code review triggered automatically. Failed executions can be retried from the UI.

</td>
</tr>
<tr>
<td>

### Missions
Define a goal, and Nexus breaks it into a checklist of verifiable outcomes. Agents work through items on a heartbeat, declare completion, and Nexus verifies each result before marking it done. Supports recurring missions via cron.

</td>
<td>

### Proposal Pipeline
Agents propose tickets with discussion context and fallback plans. AI deduplication, Nexus review with defer/approve/reject, then human approve/reject with undo. A layered judgement process — nothing ships without passing both AI and human review.

</td>
<td>

### Knowledge Base
Shared team knowledge plus per-agent memory. Auto-ingests README and docs from connected repos. Add your mission, values, OKRs, and architecture docs. Inline editing from the UI.

</td>
</tr>
<tr>
<td>

### Import Agents
Browse and import specialist agents from GitHub repos like [agency-agents](https://github.com/msitarzewski/agency-agents) with category browsing. Toggle agents on/off, customize personas and heartbeats.

</td>
<td>

### Proactive Analysis
Agents don't wait to be asked. Heartbeat schedulers drive periodic code review, proposal triage, staleness checks, and knowledge sync — continuously surfacing issues and opportunities.

</td>
<td>

### Work Verification
When a coding agent executes a ticket, the team reviews the diff. In missions, agents declare items complete and Nexus independently verifies the outcome before checking the box.

</td>
</tr>
</table>

<br/>

## The Agent Team

10 built-in specialists, each defined in a customizable markdown persona file:

| Agent | Role | Focus |
|-------|------|-------|
| **Nexus** | Director | Reviews all proposals before they reach humans. Verifies mission outcomes. Quality gate and strategy coordinator. |
| **CISO** | Security | Vulnerability triage, compliance, weekly security digests. |
| **QA Manager** | Quality | Test strategy, bug tracking, quality standards. |
| **SRE** | Reliability | Performance, infrastructure, observability. |
| **Product Manager** | Product | Roadmap alignment, feature scoping, prioritization. |
| **UX Designer** | Design | Interface usability, accessibility, design consistency. |
| **Release Engineering** | Releases | Deployment readiness, pipeline coordination. |
| **FinOps** | Cost | Cloud spend optimization, resource efficiency. |
| **AgentOps** | Platform | Agent system health and self-monitoring. |
| **VOC** | Customer | Feedback synthesis and customer advocacy. |

Each persona lives in `personas/` and can be customized. Import more from [agency-agents](https://github.com/msitarzewski/agency-agents) — 100+ specialists across engineering, design, marketing, product, and more.

<br/>

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_API_KEY` | Prompted | API key for your LLM provider (set interactively on first run) |
| `LLM_PROVIDER` | No | `gemini` (default), `anthropic`, `openai`, `ollama`, `openrouter`, `multi` |
| `DATABASE_URL` | No | PostgreSQL connection string. Omit for embedded PGlite (zero-config). |
| `EXECUTION_BACKEND` | No | `noop` (default), `claude-code`, `gemini-cli`, `codex-cli`, `openclaw`, `permaship` |
| `EXECUTION_TIMEOUT_MS` | No | Execution timeout in ms. Defaults to `3600000` (1 hour). |
| `LOG_LEVEL` | No | Defaults to `info`. Set `debug` for verbose output. |

See `.env.example` for the full list.

<br/>

## Adapter System

The core logic is decoupled from external services through 8 adapter interfaces. Run Nexus Command against any LLM, any chat platform, any project tracker.

| Adapter | Purpose | Default |
|---------|---------|---------|
| `LLMProvider` | Text generation, embeddings | Google Gemini |
| `CommunicationAdapter` | Send messages, reactions | Console / Local UI |
| `ProjectRegistry` | List and resolve projects | Local DB |
| `TicketTracker` | Suggestions and tickets | Local DB |
| `CommitProvider` | Git history for staleness | Local `git log` |
| `KnowledgeSource` | Project documentation | Local markdown files |
| `TenantResolver` | Workspace → org mapping | Single-tenant |
| `UsageSink` | Token usage metrics | Console |

Write a custom adapter: implement an interface from `src/adapters/interfaces/`, register it in `src/adapters/loader.ts`.

<br/>

## Project Structure

```
src/
  adapters/             Pluggable interfaces and implementations
    interfaces/         8 adapter contracts
    providers/          LLM providers (Anthropic, OpenAI, Ollama, Gemini)
    default/            Standalone defaults
  agents/               Agent engine, executor, router, strategy
  local/                Local UI server, execution backends
  bot/                  Message processing pipeline
  db/                   Schema and migrations (Drizzle ORM)
  missions/             Goal-driven work units with heartbeat scheduler
  nexus/                CTO review scheduler
  knowledge/            Knowledge base and RAG
ui/                     Browser chat interface
bin/                    CLI entry point
personas/               Agent persona definitions
```

<br/>

## Roadmap

- **Axon and GitNexus add-ons** — deep codebase understanding with symbol-level impact analysis and cross-repo dependency tracking
- **Obsidian brain techniques** — connect Obsidian-style knowledge vaults for user-curated domain knowledge with graph-based retrieval
- **MCP server** — expose agent capabilities as Model Context Protocol tools

<br/>

## Community

<a href="https://discord.gg/JMMMT9EDVq">
  <img src="https://img.shields.io/discord/1377706636738166834?color=5865F2&logo=discord&logoColor=white&label=Join%20the%20Discord&style=for-the-badge" alt="Discord" />
</a>

Join the Discord to report bugs, request features, share how you're using Nexus Command, or just chat. Feedback posted in the Discord is processed by the Nexus Command system itself and shapes the project directly.

### Contributing

1. Fork the repository and create a feature branch from `main`
2. Make your changes (see [CONTRIBUTING.md](CONTRIBUTING.md))
3. Ensure `npm run typecheck` and `npm run test:run` pass
4. Open a pull request

Good first contributions:
- New adapter implementations (Jira, Linear, Slack direct bot)
- New agent personas (add a markdown file to `personas/`)
- Bug fixes and improvements

<br/>

## How PermaShip Uses Nexus Command

This project powers PermaShip's AI engineering operations in production on AWS ECS. The PermaShip adapters in `src/adapters/permaship/` integrate with a comms gateway, project management API, and knowledge base — serving as a real-world reference for building your own integrations.

## License

[MIT](LICENSE)
