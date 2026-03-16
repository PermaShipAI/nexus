import type { ExecutionBackend, TicketSpec, ExecutionResult } from './index.js';
import { buildPrompt } from './index.js';
import { spawnCli } from './spawn-cli.js';

export class ClaudeCodeBackend implements ExecutionBackend {
  name = 'claude-code';

  constructor(private timeoutMs?: number) {}

  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const prompt = buildPrompt(ticket);
    return spawnCli({
      command: 'claude',
      args: ['-p', prompt, '--output-format', 'text'],
      cwd: ticket.repoPath,
      timeoutMs: this.timeoutMs,
      backendName: this.name,
    });
  }
}
