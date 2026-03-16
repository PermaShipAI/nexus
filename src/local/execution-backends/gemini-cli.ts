import type { ExecutionBackend, TicketSpec, ExecutionResult } from './index.js';
import { buildPrompt } from './index.js';
import { spawnCli } from './spawn-cli.js';

export class GeminiCliBackend implements ExecutionBackend {
  name = 'gemini-cli';

  constructor(private timeoutMs?: number) {}

  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const prompt = buildPrompt(ticket);
    return spawnCli({
      command: 'gemini',
      args: ['-p', prompt, '--yolo', '--output-format', 'text'],
      cwd: ticket.repoPath,
      timeoutMs: this.timeoutMs,
      backendName: this.name,
    });
  }
}
