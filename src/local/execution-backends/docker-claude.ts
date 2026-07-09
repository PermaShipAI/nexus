import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionBackend, TicketSpec, ExecutionResult } from './index.js';
import { buildPrompt } from './index.js';
import { logger } from '../../logger.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RUNTIME_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_PROXY_START_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_IMAGE = 'nexus-claude-code:latest';
const DEFAULT_PROXY_IMAGE = DEFAULT_IMAGE;
const WORKSPACE_MOUNT = '/workspace';
const CONTAINER_HOME = '/tmp/nexus-home';
const PROXY_ALIAS = 'anthropic-proxy';
const PROXY_PORT = 8888;
const ALLOWED_EGRESS_HOST = 'api.anthropic.com';
const ALLOWED_EGRESS_PORT = 443;
const PROXY_SCRIPT_MOUNT = '/proxy/anthropic-allowlist-proxy.mjs';
const PROXY_SCRIPT_RELATIVE_PATH = join('docker', 'egress-proxy', 'anthropic-allowlist-proxy.mjs');
const PROXY_URL = `http://${PROXY_ALIAS}:${PROXY_PORT}`;

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
  private readonly proxyImage: string;

  constructor(private timeoutMs?: number, runner?: DockerCommandRunner) {
    this.runner = runner ?? new SpawnDockerCommandRunner();
    this.image = process.env.NEXUS_DOCKER_CLAUDE_IMAGE ?? DEFAULT_IMAGE;
    this.proxyImage = process.env.NEXUS_EGRESS_PROXY_IMAGE ?? DEFAULT_PROXY_IMAGE;
  }

  async execute(ticket: TicketSpec): Promise<ExecutionResult> {
    const labKey = this.resolveLabKey();
    if (!labKey.ok) {
      return { success: false, error: labKey.error };
    }

    const dockerEnv = buildDockerProcessEnv();
    const claudeEnv = buildDockerProcessEnv(labKey.value);
    const runtimeCheck = await this.runner.run(
      this.runtime,
      ['version', '--format', '{{.Server.Version}}'],
      { env: dockerEnv, timeoutMs: DEFAULT_RUNTIME_CHECK_TIMEOUT_MS },
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
    const resources = makeDockerResourceNames(ticket.ticketId);
    const proxyScriptPath = resolveProxyScriptPath();
    if (!existsSync(proxyScriptPath)) {
      return {
        success: false,
        error: `Docker Claude egress proxy script was not found: ${proxyScriptPath}`,
      };
    }

    logger.info(
      {
        backend: this.name,
        ticketId: ticket.ticketId,
        runtime: this.runtime,
        sandboxProfile: 'docker-claude:worktree-only',
        networkProfile: 'internal-network-via-anthropic-allowlist-proxy',
        mountTarget: WORKSPACE_MOUNT,
        allowedEgress: `${ALLOWED_EGRESS_HOST}:${ALLOWED_EGRESS_PORT}`,
      },
      'Starting sandboxed Claude backend',
    );

    try {
      const networkCreate = await this.runner.run(
        this.runtime,
        ['network', 'create', '--internal', resources.networkName],
        { env: dockerEnv, timeoutMs: DEFAULT_RUNTIME_CHECK_TIMEOUT_MS },
      );
      if (networkCreate.error || networkCreate.code !== 0) {
        return {
          success: false,
          error: formatDockerFailure('create internal egress network', networkCreate),
        };
      }

      const proxyStart = await this.runner.run(
        this.runtime,
        buildProxyRunArgs(resources.proxyContainerName, resources.networkName, this.proxyImage, proxyScriptPath),
        { env: dockerEnv, timeoutMs: DEFAULT_PROXY_START_TIMEOUT_MS },
      );
      if (proxyStart.error || proxyStart.code !== 0) {
        return {
          success: false,
          output: proxyStart.stdout,
          error: formatDockerFailure('start Anthropic egress proxy', proxyStart),
        };
      }

      const bridgeConnect = await this.runner.run(
        this.runtime,
        ['network', 'connect', 'bridge', resources.proxyContainerName],
        { env: dockerEnv, timeoutMs: DEFAULT_RUNTIME_CHECK_TIMEOUT_MS },
      );
      if (bridgeConnect.error || bridgeConnect.code !== 0) {
        return {
          success: false,
          output: bridgeConnect.stdout,
          error: formatDockerFailure('dual-home Anthropic egress proxy onto bridge', bridgeConnect),
        };
      }

      const proxyProbe = await this.runner.run(
        this.runtime,
        buildProxyProbeArgs(resources.networkName, this.proxyImage),
        { env: dockerEnv, timeoutMs: DEFAULT_RUNTIME_CHECK_TIMEOUT_MS },
      );
      if (proxyProbe.error || proxyProbe.code !== 0) {
        return {
          success: false,
          output: proxyProbe.stdout,
          error: formatDockerFailure('verify Anthropic egress proxy is reachable on the internal network', proxyProbe),
        };
      }

      const args = buildDockerRunArgs(ticket.repoPath, resources.claudeContainerName, resources.networkName, this.image);
      const result = await this.runner.run(this.runtime, args, {
        env: claudeEnv,
        input: prompt,
        timeoutMs: this.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      if (result.timedOut) {
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
    } finally {
      await this.cleanupResources(resources, dockerEnv);
    }
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

  private async cleanupResources(resources: DockerResourceNames, env: Record<string, string>) {
    for (const containerName of [resources.claudeContainerName, resources.proxyContainerName]) {
      await this.runner.run(this.runtime, ['rm', '-f', containerName], {
        env,
        timeoutMs: DEFAULT_CLEANUP_TIMEOUT_MS,
      });
    }
    await this.runner.run(this.runtime, ['network', 'rm', resources.networkName], {
      env,
      timeoutMs: DEFAULT_CLEANUP_TIMEOUT_MS,
    });
  }
}

interface DockerResourceNames {
  claudeContainerName: string;
  proxyContainerName: string;
  networkName: string;
}

function buildDockerRunArgs(repoPath: string, containerName: string, networkName: string, image: string): string[] {
  const worktreeMount = `type=bind,source=${repoPath},target=${WORKSPACE_MOUNT}`;

  return [
    'run',
    '--rm',
    '--interactive',
    '--name',
    containerName,
    '--pull',
    'never',
    '--network',
    networkName,
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
    '--env',
    `HTTPS_PROXY=${PROXY_URL}`,
    '--env',
    `HTTP_PROXY=${PROXY_URL}`,
    '--env',
    `https_proxy=${PROXY_URL}`,
    '--env',
    `http_proxy=${PROXY_URL}`,
    '--env',
    'NO_PROXY=localhost,127.0.0.1',
    image,
    '-p',
    '--output-format',
    'text',
  ];
}

function buildProxyRunArgs(
  containerName: string,
  networkName: string,
  proxyImage: string,
  proxyScriptPath: string,
): string[] {
  return [
    'run',
    '--rm',
    '--detach',
    '--name',
    containerName,
    '--pull',
    'never',
    '--network',
    networkName,
    '--network-alias',
    PROXY_ALIAS,
    '--mount',
    `type=bind,source=${proxyScriptPath},target=${PROXY_SCRIPT_MOUNT},readonly`,
    '--env',
    `ALLOW_HOST=${ALLOWED_EGRESS_HOST}`,
    '--env',
    `ALLOW_PORT=${ALLOWED_EGRESS_PORT}`,
    '--env',
    `PORT=${PROXY_PORT}`,
    '--entrypoint',
    'node',
    proxyImage,
    PROXY_SCRIPT_MOUNT,
  ];
}

function buildProxyProbeArgs(networkName: string, proxyImage: string): string[] {
  const script = `
const net = require('node:net');
const socket = net.connect(Number(process.env.PROXY_PORT), process.env.PROXY_HOST);
const timer = setTimeout(() => {
  console.error('proxy probe timed out');
  socket.destroy();
  process.exit(1);
}, 3000);
socket.once('connect', () => {
  clearTimeout(timer);
  socket.end();
  process.exit(0);
});
socket.once('error', (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exit(1);
});
`;

  return [
    'run',
    '--rm',
    '--network',
    networkName,
    '--pull',
    'never',
    '--env',
    `PROXY_HOST=${PROXY_ALIAS}`,
    '--env',
    `PROXY_PORT=${PROXY_PORT}`,
    '--entrypoint',
    'node',
    proxyImage,
    '-e',
    script,
  ];
}

function buildDockerProcessEnv(labAnthropicApiKey?: string): Record<string, string> {
  const env: Record<string, string> = {
    FORCE_COLOR: '0',
  };

  if (labAnthropicApiKey) {
    env.ANTHROPIC_API_KEY = labAnthropicApiKey;
  }

  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }

  return env;
}

function makeDockerResourceNames(ticketId: string): DockerResourceNames {
  const suffix = ticketId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40) || 'ticket';
  const timestamp = Date.now();
  return {
    claudeContainerName: `nexus-claude-${suffix}-${timestamp}`,
    proxyContainerName: `nexus-claude-proxy-${suffix}-${timestamp}`,
    networkName: `nexus-claude-egress-${suffix}-${timestamp}`,
  };
}

function resolveProxyScriptPath(): string {
  return process.env.NEXUS_EGRESS_PROXY_SCRIPT ?? join(process.cwd(), PROXY_SCRIPT_RELATIVE_PATH);
}

function formatDockerFailure(action: string, result: DockerRunResult): string {
  const details = result.error?.message || result.stderr || result.stdout || `exit code ${result.code}`;
  return `Failed to ${action}: ${details}`.trim();
}
