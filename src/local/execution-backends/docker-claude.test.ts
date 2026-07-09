import '../../tests/env.js';
import { describe, it, expect, beforeEach } from 'vitest';
import type { TicketSpec } from './index.js';
import { createExecutionBackend } from './factory.js';
import { DockerClaudeBackend, type DockerCommandRunner, type DockerRunResult } from './docker-claude.js';

const ticket: TicketSpec = {
  ticketId: 'ticket-123',
  kind: 'feature',
  title: 'Sandbox task',
  description: 'Do the sandboxed work.',
  repoPath: 'C:\\lab\\ticket-worktree',
  repoKey: 'nexus',
};

type DockerCall = {
  command: string;
  args: string[];
  options: { env: Record<string, string>; input?: string; timeoutMs?: number };
};

function makeRunner(handler?: (call: DockerCall) => DockerRunResult): DockerCommandRunner & { calls: DockerCall[] } {
  const calls: DockerCall[] = [];

  const runner: DockerCommandRunner = {
    calls,
    async run(command, args, options) {
      const call = {
        command,
        args,
        options: { env: options.env, input: options.input, timeoutMs: options.timeoutMs },
      };
      calls.push(call);
      if (handler) {
        return handler(call);
      }
      if (args[0] === 'version') {
        return {
          code: 0,
          stdout: '25.0.0\n',
          stderr: '',
        };
      }
      if (args[0] === 'run' && args.includes('-p')) {
        return {
          code: 0,
          stdout: 'done\n',
          stderr: '',
        };
      }
      return {
        code: 0,
        stdout: '',
        stderr: '',
      };
    },
  };

  return runner as DockerCommandRunner & { calls: DockerCall[] };
}

function findCall(calls: DockerCall[], predicate: (call: DockerCall) => boolean): DockerCall {
  const call = calls.find(predicate);
  if (!call) {
    throw new Error(`Expected Docker call not found. Calls: ${calls.map(c => c.args.join(' ')).join('\n')}`);
  }
  return call;
}

describe('DockerClaudeBackend', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.LAB_ANTHROPIC_API_KEY = 'lab-key';
  });

  it('fails closed when Docker is unavailable', async () => {
    const runner = makeRunner((call) => {
      if (call.args[0] === 'version') {
        return { code: 1, stdout: '', stderr: 'docker unavailable' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const backend = new DockerClaudeBackend(60_000, runner);

    const result = await backend.execute(ticket);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Docker runtime is unavailable');
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toEqual(['version', '--format', '{{.Server.Version}}']);
  });

  it('creates an internal network and dual-homes the proxy only', async () => {
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    await backend.execute(ticket);

    const networkCreate = findCall(runner.calls, call => call.args[0] === 'network' && call.args[1] === 'create');
    expect(networkCreate.args).toContain('--internal');

    const proxyRun = findCall(runner.calls, call => call.args[0] === 'run' && call.args.includes('--network-alias'));
    expect(proxyRun.args).toContain('--network');
    expect(proxyRun.args[proxyRun.args.indexOf('--network') + 1]).toMatch(/^nexus-claude-egress-/);
    expect(proxyRun.args).toContain('--network-alias');
    expect(proxyRun.args[proxyRun.args.indexOf('--network-alias') + 1]).toBe('anthropic-proxy');
    expect(proxyRun.args).toContain('--entrypoint');
    expect(proxyRun.args[proxyRun.args.indexOf('--entrypoint') + 1]).toBe('node');
    expect(proxyRun.options.env.ANTHROPIC_API_KEY).toBeUndefined();

    const networkConnect = findCall(runner.calls, call => call.args[0] === 'network' && call.args[1] === 'connect');
    expect(networkConnect.args).toEqual(['network', 'connect', 'bridge', expect.stringMatching(/^nexus-claude-proxy-/)]);
  });

  it('runs Claude interactively on the internal network through the proxy', async () => {
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    await backend.execute(ticket);

    const dockerRun = findCall(runner.calls, call => call.args[0] === 'run' && call.args.includes('-p'));
    expect(dockerRun.args).toContain('--interactive');
    expect(dockerRun.args).toContain('--network');
    expect(dockerRun.args[dockerRun.args.indexOf('--network') + 1]).toMatch(/^nexus-claude-egress-/);
    expect(dockerRun.args).not.toContain('none');
    expect(dockerRun.args).toContain('--env');
    expect(dockerRun.args).toContain('HTTPS_PROXY=http://anthropic-proxy:8888');
    expect(dockerRun.args).toContain('HTTP_PROXY=http://anthropic-proxy:8888');
    expect(dockerRun.options.input).toContain(ticket.description);
  });

  it('injects only the lab-scoped Anthropic key into the Docker process', async () => {
    process.env.ANTHROPIC_API_KEY = 'host-production-key';
    process.env.LAB_ANTHROPIC_API_KEY = 'lab-only-key';
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    await backend.execute(ticket);

    const dockerRun = findCall(runner.calls, call => call.args[0] === 'run' && call.args.includes('-p'));
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

    const dockerRun = findCall(runner.calls, call => call.args[0] === 'run' && call.args.includes('-p'));
    const mounts = dockerRun.args
      .map((arg, index) => (arg === '--mount' ? dockerRun.args[index + 1] : undefined))
      .filter((arg): arg is string => Boolean(arg));

    expect(mounts).toEqual([`type=bind,source=${ticket.repoPath},target=/workspace`]);
    expect(dockerRun.args).not.toContain('/var/run/docker.sock');
    expect(dockerRun.args).not.toContain(process.env.USERPROFILE ?? '');
    expect(dockerRun.args).toContain('--workdir');
    expect(dockerRun.args[dockerRun.args.indexOf('--workdir') + 1]).toBe('/workspace');
  });

  it('omits Claude host permission bypass flags', async () => {
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    await backend.execute(ticket);

    const dockerRun = findCall(runner.calls, call => call.args[0] === 'run' && call.args.includes('-p'));
    expect(dockerRun.args).not.toContain('--dangerously-skip-permissions');
    expect(dockerRun.args).toContain('-p');
    expect(dockerRun.args).toContain('--output-format');
    expect(dockerRun.args).toContain('text');
  });

  it('cleans up Claude, proxy, and internal network after each run', async () => {
    const runner = makeRunner();
    const backend = new DockerClaudeBackend(60_000, runner);

    await backend.execute(ticket);

    expect(runner.calls.some(call => call.args[0] === 'rm' && call.args[1] === '-f' && /^nexus-claude-ticket-123-/.test(call.args[2]))).toBe(true);
    expect(runner.calls.some(call => call.args[0] === 'rm' && call.args[1] === '-f' && /^nexus-claude-proxy-ticket-123-/.test(call.args[2]))).toBe(true);
    expect(runner.calls.some(call => call.args[0] === 'network' && call.args[1] === 'rm' && /^nexus-claude-egress-ticket-123-/.test(call.args[2]))).toBe(true);
  });

  it('is selectable without changing the host backend defaults', () => {
    expect(createExecutionBackend('docker-claude').name).toBe('docker-claude');
    expect(createExecutionBackend('sandboxed-claude-code').name).toBe('docker-claude');
    expect(createExecutionBackend('claude-code').name).toBe('claude-code');
  });
});
