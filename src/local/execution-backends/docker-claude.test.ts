import '../../tests/env.js';
import { describe, it, expect, beforeEach } from 'vitest';
import type { TicketSpec } from './index.js';
import { createExecutionBackend } from './factory.js';
import { DockerClaudeBackend, type DockerCommandRunner } from './docker-claude.js';

const ticket: TicketSpec = {
  ticketId: 'ticket-123',
  kind: 'feature',
  title: 'Sandbox task',
  description: 'Do the sandboxed work.',
  repoPath: 'C:\\lab\\ticket-worktree',
  repoKey: 'nexus',
};

function makeRunner(versionExitCode = 0, runExitCode = 0): DockerCommandRunner {
  const calls: Array<{ command: string; args: string[]; options: { env: Record<string, string> } }> = [];

  const runner: DockerCommandRunner = {
    calls,
    async run(command, args, options) {
      calls.push({ command, args, options: { env: options.env } });
      if (args[0] === 'version') {
        return {
          code: versionExitCode,
          stdout: versionExitCode === 0 ? '25.0.0\n' : '',
          stderr: versionExitCode === 0 ? '' : 'docker unavailable',
        };
      }
      return {
        code: runExitCode,
        stdout: runExitCode === 0 ? 'done\n' : '',
        stderr: runExitCode === 0 ? '' : 'container failed',
      };
    },
  };

  return runner;
}

describe('DockerClaudeBackend', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.LAB_ANTHROPIC_API_KEY = 'lab-key';
  });

  it('fails closed when Docker is unavailable', async () => {
    const runner = makeRunner(1);
    const backend = new DockerClaudeBackend(60_000, runner);

    const result = await backend.execute(ticket);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Docker runtime is unavailable');
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toEqual(['version', '--format', '{{.Server.Version}}']);
  });

  it('runs the container with no network', async () => {
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    await backend.execute(ticket);

    const dockerRun = runner.calls[1];
    expect(dockerRun.args).toContain('--network');
    expect(dockerRun.args[dockerRun.args.indexOf('--network') + 1]).toBe('none');
  });

  it('injects only the lab-scoped Anthropic key into the Docker process', async () => {
    process.env.ANTHROPIC_API_KEY = 'host-production-key';
    process.env.LAB_ANTHROPIC_API_KEY = 'lab-only-key';
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    await backend.execute(ticket);

    const dockerRun = runner.calls[1];
    expect(dockerRun.options.env.ANTHROPIC_API_KEY).toBe('lab-only-key');
    expect(dockerRun.options.env.LAB_ANTHROPIC_API_KEY).toBeUndefined();
    expect(dockerRun.options.env.HOME).toBeUndefined();
    expect(dockerRun.options.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(dockerRun.args).not.toContain('host-production-key');
    expect(dockerRun.args).not.toContain('lab-only-key');
  });

  it('refuses to use the host Anthropic key when the lab key is missing', async () => {
    delete process.env.LAB_ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'host-production-key';
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    const result = await backend.execute(ticket);

    expect(result.success).toBe(false);
    expect(result.error).toContain('LAB_ANTHROPIC_API_KEY is required');
    expect(runner.calls).toHaveLength(0);
  });

  it('mounts only the ticket worktree read-write', async () => {
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    await backend.execute(ticket);

    const dockerRun = runner.calls[1];
    const mounts = dockerRun.args
      .map((arg, index) => (arg === '--mount' ? dockerRun.args[index + 1] : undefined))
      .filter((arg): arg is string => Boolean(arg));

    expect(mounts).toEqual([`type=bind,source=${ticket.repoPath},target=/workspace,readwrite`]);
    expect(dockerRun.args).not.toContain('/var/run/docker.sock');
    expect(dockerRun.args).not.toContain(process.env.USERPROFILE ?? '');
    expect(dockerRun.args).toContain('--workdir');
    expect(dockerRun.args[dockerRun.args.indexOf('--workdir') + 1]).toBe('/workspace');
  });

  it('omits Claude host permission bypass flags', async () => {
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    await backend.execute(ticket);

    const dockerRun = runner.calls[1];
    expect(dockerRun.args).not.toContain('--dangerously-skip-permissions');
    expect(dockerRun.args).toContain('-p');
    expect(dockerRun.args).toContain('--output-format');
    expect(dockerRun.args).toContain('text');
  });

  it('is selectable without changing the host backend defaults', () => {
    expect(createExecutionBackend('docker-claude').name).toBe('docker-claude');
    expect(createExecutionBackend('sandboxed-claude-code').name).toBe('docker-claude');
    expect(createExecutionBackend('claude-code').name).toBe('claude-code');
  });
});
