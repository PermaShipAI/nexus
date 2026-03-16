import { config } from '../../config.js';
import type { ExecutionBackend } from './index.js';
import { NoopBackend } from './noop.js';
import { ClaudeCodeBackend } from './claude-code.js';
import { GeminiCliBackend } from './gemini-cli.js';
import { CodexCliBackend } from './codex-cli.js';
import { OpenClawBackend } from './openclaw.js';

export function createExecutionBackend(): ExecutionBackend {
  const timeout = config.EXECUTION_TIMEOUT_MS;

  switch (config.EXECUTION_BACKEND) {
    case 'claude-code': return new ClaudeCodeBackend(timeout);
    case 'gemini-cli':  return new GeminiCliBackend(timeout);
    case 'codex-cli':   return new CodexCliBackend(timeout);
    case 'openclaw':    return new OpenClawBackend(timeout);
    case 'noop':
    default:            return new NoopBackend();
  }
}
