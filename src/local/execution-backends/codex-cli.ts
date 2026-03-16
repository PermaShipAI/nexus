import type { ExecutionBackend, TicketSpec, ExecutionResult } from './index.js';
import { buildPrompt } from './index.js';
import { spawnCli } from './spawn-cli.js';

export class CodexCliBackend implements ExecutionBackend {
  name = 'codex-cli';

  constructor(private timeoutMs?: number) {}

  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const prompt = buildPrompt(ticket);
    return spawnCli({
      command: 'codex',
      args: ['--approval-mode', 'full-auto', '-q', prompt],
      cwd: ticket.repoPath,
      timeoutMs: this.timeoutMs,
      backendName: this.name,
    });
  }
}
