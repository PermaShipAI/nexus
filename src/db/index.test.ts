import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

// Set up a temp PGlite directory BEFORE db module import (module-scope side effect)
const testDataDir = mkdtempSync(join(tmpdir(), 'nexus-db-test-'));
process.env.PGLITE_DATA_DIR = testDataDir;
delete process.env.DATABASE_URL;

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('database migration system', () => {
  afterAll(async () => {
    const { closeDb } = await import('./index.js');
    await closeDb();
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('applies all migrations without error', async () => {
    const { runMigrations } = await import('./index.js');
    await expect(runMigrations()).resolves.not.toThrow();
  }, 15000);

  it('is idempotent — running migrations twice does not throw', async () => {
    const { runMigrations } = await import('./index.js');
    await expect(runMigrations()).resolves.not.toThrow();
  }, 15000);

  it('creates the migrations tracking table', async () => {
    const { db } = await import('./index.js');
    const result = await db.execute(sql`SELECT count(*) as cnt FROM "__drizzle_migrations"`);
    expect(result).toBeDefined();
  });

  it('closeDb resolves without error', async () => {
    const { closeDb } = await import('./index.js');
    await expect(closeDb()).resolves.not.toThrow();
  });
});
