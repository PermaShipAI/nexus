import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFiles } from './env.js';

const originalExecutionBackend = process.env.EXECUTION_BACKEND;

describe('loadEnvFiles', () => {
  afterEach(() => {
    if (originalExecutionBackend === undefined) {
      delete process.env.EXECUTION_BACKEND;
    } else {
      process.env.EXECUTION_BACKEND = originalExecutionBackend;
    }
  });

  it('loads config/.env as a local default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-env-'));
    try {
      mkdirSync(join(dir, 'config'));
      writeFileSync(join(dir, 'config', '.env'), 'EXECUTION_BACKEND=docker-claude\n');
      delete process.env.EXECUTION_BACKEND;

      loadEnvFiles(dir);

      expect(process.env.EXECUTION_BACKEND).toBe('docker-claude');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not override an explicit process environment value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-env-'));
    try {
      mkdirSync(join(dir, 'config'));
      writeFileSync(join(dir, 'config', '.env'), 'EXECUTION_BACKEND=docker-claude\n');
      process.env.EXECUTION_BACKEND = 'noop';

      loadEnvFiles(dir);

      expect(process.env.EXECUTION_BACKEND).toBe('noop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
