import { spawn } from 'node:child_process';
import type { ExecutionBackend, TicketSpec, ExecutionResult } from './index.js';
import { buildPrompt } from './index.js';
import { logger } from '../../logger.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RUNTIME_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_IMAGE = 'nexus-claude-code:latest';
const WORKSPACE_MOUNT = '/workspace';
const CONTAINER_HOME = '/tmp/nexus-home';

export interface DockerRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: Error;
}

export interface DockerCommandOptions {
  env: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

export interface DockerCommandRunner {
  run(command: string, args: string[], options: DockerCommandOptions): Promise<DockerRunResult>;
}

class SpawnDockerCommandRunner implements DockerCommandRunner {
  async run(command: string, args: string[], options: DockerCommandOptions): Promise<DockerRunResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<DockerRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const child = spawn(command, args, {
        env: options.env,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });

      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const finish = (result: DockerRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({ code: null, stdout, stderr, timedOut: true });
      }, timeoutMs);

      child.on('error', (error) => {
        finish({ code: null, stdout, stderr, error });
      });

      child.on('close', (code) => {
        finish({ code, stdout, stderr });
      });
    });
  }
}

export class DockerClaudeBackend implements ExecutionBackend {
  name = 'docker-claude';

  private readonly runner: DockerCommandRunner;
  private readonly runtime = 'docker';
  private readonly image: string;

  constructor(private timeoutMs?: number, runner?: DockerCommandRunner) {
    this.runner = runner ?? new SpawnDockerCommandRunner();
    this.image = process.env.NEXUS_DOCKER_CLAUDE_IMAGE ?? DEFAULT_IMAGE;
  }

  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const labKey = this.resolveLabKey();
    if (!labKey.ok) {
      return { success: false, error: labKey.error };
    }

    const env = buildDockerProcessEnv(labKey.value);
    const runtimeCheck = await this.runner.run(
      this.runtime,
      ['version', '--format', '{{.Server.Version}}'],
      { env, timeoutMs: DEFAULT_RUNTIME_CHECK_TIMEOUT_MS },
    );

    if (runtimeCheck.error || runtimeCheck.code !== 0) {
      return {
        success: false,
        error: `Docker runtime is unavailable for sandboxed Claude execution; refusing host fallback. ${
          runtimeCheck.error?.message ?? runtimeCheck.stderr
        }`.trim(),
      };
    }

    const prompt = buildPrompt(ticket);
    const containerName = makeContainerName(ticket.ticketId);
    const args = buildDockerRunArgs(ticket.repoPath, containerName, this.image);

    logger.info(
      {
        backend: this.name,
        ticketId: ticket.ticketId,
        runtime: this.runtime,
        sandboxProfile: 'docker-claude:worktree-only',
        networkProfile: 'none',
        mountTarget: WORKSPACE_MOUNT,
      },
      'Starting sandboxed Claude backend',
    );

    const result = await this.runner.run(this.runtime, args, {
      env,
      input: prompt,
      timeoutMs: this.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (result.timedOut) {
      await this.cleanupContainer(containerName, env);
      return {
        success: false,
        output: result.stdout,
        error: `Sandboxed Claude execution timed out after ${(this.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`,
      };
    }

    if (result.error) {
      return { success: false, error: `Failed to run Docker Claude backend: ${result.error.message}` };
    }

    if (result.code === 0) {
      return { success: true, output: result.stdout };
    }

    return {
      success: false,
      output: result.stdout,
      error: result.stderr || `Sandboxed Claude container exited with code ${result.code}`,
    };
  }

  private resolveLabKey(): { ok: true; value: string } | { ok: false; error: string } {
    const labKey = process.env.LAB_ANTHROPIC_API_KEY;

    if (!labKey) {
      return {
        ok: false,
        error: 'LAB_ANTHROPIC_API_KEY is required for docker-claude; refusing to use host ANTHROPIC_API_KEY.',
      };
    }

    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY === labKey) {
      return {
        ok: false,
        error: 'LAB_ANTHROPIC_API_KEY must be distinct from host ANTHROPIC_API_KEY for docker-claude.',
      };
    }

    return { ok: true, value: labKey };
  }

  private async cleanupContainer(containerName: string, env: Record<string, string>) {
    await this.runner.run(this.runtime, ['rm', '-f', containerName], {
      env,
      timeoutMs: DEFAULT_CLEANUP_TIMEOUT_MS,
    });
  }
}

function buildDockerRunArgs(repoPath: string, containerName: string, image: string): string[] {
  const worktreeMount = `type=bind,source=${repoPath},target=${WORKSPACE_MOUNT},readwrite`;

  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--pull',
    'never',
    // TODO(#4): replace default-deny with an explicit egress allowlist profile when approved.
    '--network',
    'none',
    '--workdir',
    WORKSPACE_MOUNT,
    '--mount',
    worktreeMount,
    '--env',
    'ANTHROPIC_API_KEY',
    '--env',
    `HOME=${CONTAINER_HOME}`,
    '--env',
    `XDG_CONFIG_HOME=${CONTAINER_HOME}/.config`,
    '--env',
    `XDG_DATA_HOME=${CONTAINER_HOME}/.local/share`,
    '--env',
    `XDG_CACHE_HOME=${CONTAINER_HOME}/.cache`,
    image,
    '-p',
    '--output-format',
    'text',
  ];
}

function buildDockerProcessEnv(labAnthropicApiKey: string): Record<string, string> {
  const env: Record<string, string> = {
    FORCE_COLOR: '0',
    ANTHROPIC_API_KEY: labAnthropicApiKey,
  };

  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }

  return env;
}

function makeContainerName(ticketId: string): string {
  const suffix = ticketId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40) || 'ticket';
  return `nexus-claude-${suffix}-${Date.now()}`;
}
