# Contributing

Thank you for your interest in contributing to Agents!

## Ways to Contribute

### Join the Discord

The fastest way to contribute is to **[join the PermaShip Discord](https://discord.gg/permaship)**. Report bugs, request features, ask questions, or share how you're using Agents. Feedback posted in the Discord is processed by the Agents system itself and built by PermaShip into the codebase, so your input directly shapes the project.

### Report Issues

Open a GitHub issue with:
- A clear description of the problem or feature request
- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Environment details (Node version, OS, database, etc.)

### Submit Code

1. Fork the repository and create a branch from `main`
2. Follow the development setup below
3. Make your changes
4. Ensure `npm run typecheck` and `npm run test:run` pass
5. Open a pull request with a clear description of what changed and why

Keep PRs focused on a single change. If you're planning a large change, open an issue first to discuss the approach.

## Development Setup

```bash
git clone https://github.com/<your-fork>/agents.git
cd agents
npm install
cp .env.example .env
# Edit .env — set DATABASE_URL and LLM_API_KEY at minimum
npm run db:migrate
npm run dev
```

### Prerequisites

- Node.js v20+
- PostgreSQL (local or remote)
- A Google Gemini API key (free tier is sufficient for development)

## Code Style

- TypeScript with strict mode
- ESLint + Prettier for formatting
- Run `npm run lint:fix` and `npm run format:write` before committing

## Testing

```bash
npm run test:run        # Run tests once
npm run test            # Watch mode
npm run test:coverage   # With coverage report
npm run typecheck       # Type checking only
```

## Good First Contributions

### New Adapter Implementations

The adapter system is designed to be extended. Some ideas:

- **OpenAI or Anthropic `LLMProvider`** — use a different model behind the same interface
- **Jira or Linear `TicketTracker`** — create tickets in an external project tracker
- **Direct Discord/Slack `CommunicationAdapter`** — send messages without a comms gateway
- **GitHub/GitLab `CommitProvider`** — fetch commits via API instead of local git

To write an adapter:
1. Implement the interface from `src/adapters/interfaces/`
2. Place your implementation in `src/adapters/<your-adapter>/`
3. Register it as a new profile in `src/adapters/loader.ts`

Reference: `src/adapters/default/` for minimal examples, `src/adapters/permaship/` for a production integration.

### New Agent Personas

Add a markdown file to `personas/` following the format of existing personas. The system will pick it up automatically. A persona defines the agent's title, role description, decision framework, and behavioral guidelines.

### Bug Fixes and Improvements

Check the GitHub issues for open bugs or look for `TODO` comments in the codebase.
