import type { ExecutionBackend, TicketSpec, ExecutionResult } from './index.js';
import { buildPrompt } from './index.js';
import { spawnCli } from './spawn-cli.js';

export class OpenClawBackend implements ExecutionBackend {
  name = 'openclaw';

  constructor(private timeoutMs?: number) {}

  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const prompt = buildPrompt(ticket);
    return spawnCli({
      command: 'openclaw',
      args: ['run', '--task', prompt, '--repo', ticket.repoPath],
      cwd: ticket.repoPath,
      timeoutMs: this.timeoutMs,
      backendName: this.name,
    });
  }
}
