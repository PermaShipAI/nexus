# Quick Start

Get the Nexus Command agent system running locally in under 2 minutes.

## Prerequisites

- **Node.js 20+** (`node --version`)
- **An LLM API key** from any of: [Gemini](https://aistudio.google.com/apikey), [Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/api-keys), or run [Ollama](https://ollama.ai) locally (free, no key)

That's it. No Docker, no PostgreSQL, no other dependencies.

## Setup

```bash
git clone <repo-url> nexus-command
cd nexus-command
npm install
npm run dev
```

On first run, the terminal will ask you to pick an LLM provider and paste your API key. If you skip it, the browser UI will prompt you instead.

Open **http://localhost:3000** and start chatting.

## What happens behind the scenes

- An embedded database (PGlite) is created in `./data/pglite/` — no Postgres needed
- Migrations run automatically
- 10 agent personas are loaded from `personas/*.md`
- The web UI starts on port 3000

## Next steps

1. **Connect a project** — click "+ Add Project" in the sidebar (local folder or GitHub URL)
2. **Choose an executor** — in Settings, pick Claude Code, Gemini CLI, etc. to execute approved tickets
3. **Chat** — messages are auto-routed to the right specialist agent

## Using PostgreSQL instead

If you prefer an external PostgreSQL database (for production or persistence):

```bash
# Start postgres
docker compose up -d

# Set in .env
DATABASE_URL=postgresql://nexus:nexus@localhost:5432/nexus
```

When `DATABASE_URL` is set, the system uses it instead of the embedded database.

## Troubleshooting

**Port 3000 in use** — set `LOCAL_UI_PORT=3001` in `.env`

**API errors** — set `LOG_LEVEL=debug` in `.env` and check terminal output

**Reset database** — delete `./data/pglite/` directory and restart

**Use external Postgres** — set `DATABASE_URL` in `.env` and run `docker compose up -d`
