import { DockerClaudeBackend } from '../src/local/execution-backends/docker-claude.js';

const repoPath = process.env.NEXUS_PROOF_REPO_PATH;
if (!repoPath) {
  throw new Error('NEXUS_PROOF_REPO_PATH is required');
}

const backend = new DockerClaudeBackend(180_000);
const result = await backend.execute({
  ticketId: 'acceptance-egress-e2e',
  kind: 'feature',
  title: 'Trusted backend e2e proof',
  description:
    'Trusted one-off task: write a hello-world TypeScript function. Return only a concise TypeScript code block. Do not create or modify files.',
  repoPath,
  repoKey: 'nexus',
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.success ? 0 : 1);
