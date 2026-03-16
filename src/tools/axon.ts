import { execFile } from 'child_process';

interface AxonResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

const TIMEOUT_MS = 60_000;

function runAxon(args: string[], cwd: string): Promise<AxonResult> {
  return new Promise((resolve) => {
    execFile('axon', args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      try {
        resolve({ success: true, data: JSON.parse(stdout) });
      } catch {
        resolve({ success: true, data: stdout.trim() });
      }
    });
  });
}

export function axonQuery(cwd: string, query: string): Promise<AxonResult> {
  return runAxon(['query', query, '--json'], cwd);
}

export function axonContext(cwd: string, symbol: string): Promise<AxonResult> {
  return runAxon(['context', symbol, '--json'], cwd);
}

export function axonImpact(cwd: string, symbol: string): Promise<AxonResult> {
  return runAxon(['impact', symbol, '--json'], cwd);
}

export function axonDeadCode(cwd: string): Promise<AxonResult> {
  return runAxon(['dead-code', '--json'], cwd);
}
