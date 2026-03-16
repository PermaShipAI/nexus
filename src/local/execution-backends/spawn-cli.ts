import { spawn } from 'node:child_process';
import { logger } from '../../logger.js';
import type { ExecutionResult } from './index.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Environment variables safe to pass to execution backends */
const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
  'NODE_ENV', 'TMPDIR', 'TMP', 'TEMP',
  // Provider keys the CLI tools need
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
]);

/** Build a sanitized environment for subprocesses (C3) */
function buildSafeEnv(): Record<string, string> {
  const safe: Record<string, string> = { FORCE_COLOR: '0' };
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) safe[key] = process.env[key]!;
  }
  return safe;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  backendName: string;
}

/**
 * Spawn a CLI tool and capture its output.
 * Runs with a sanitized environment (no DB credentials, internal secrets, etc.)
 */
export async function spawnCli(opts: SpawnOptions): Promise<ExecutionResult> {
  const { command, args, cwd, backendName } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  logger.info({ backend: backendName, command, cwd }, 'Spawning execution backend');

  return new Promise<ExecutionResult>((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(command, args, {
      cwd,
      env: buildSafeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        success: false,
        output: stdout,
        error: `Execution timed out after ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.error({ err, backend: backendName }, 'Execution backend spawn failed');
      resolve({
        success: false,
        error: `Failed to spawn ${command}: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info({ backend: backendName, outputLength: stdout.length }, 'Execution backend completed');
        resolve({ success: true, output: stdout });
      } else {
        logger.warn({ backend: backendName, code, stderr: stderr.slice(0, 500) }, 'Execution backend exited with error');
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Process exited with code ${code}`,
        });
      }
    });
  });
}
