import { drizzle as drizzlePg, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { mkdirSync, readFileSync, readdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from './schema.js';
import { logger } from '../logger.js';

const DATABASE_URL = process.env.DATABASE_URL;

let _migrateFn: ((db: any, opts: { migrationsFolder: string }) => Promise<void>) | null = null;
let _pgliteClient: PGlite | null = null;

async function manualMigratePglite(db: any, opts: { migrationsFolder: string }): Promise<void> {
  const client = _pgliteClient;
  if (!client) throw new Error('PGlite client not initialized');
  
  // Create drizzle migrations table if it doesn't exist
  await client.query(`

    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);

  const migrationsFolder = opts.migrationsFolder;
  const files = readdirSync(migrationsFolder)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const result = await client.query('SELECT * FROM "__drizzle_migrations" WHERE hash = $1', [file]);
    if (result.rows.length > 0) continue;


    logger.info({ file }, 'Applying migration');
    const content = readFileSync(join(migrationsFolder, file), 'utf-8');
    const statements = content.split('--> statement-breakpoint');
    
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        await client.query(trimmed);
      } catch (err) {
        logger.error({ err, file, stmt: trimmed.slice(0, 100) }, 'Migration statement failed');
        throw err;
      }
    }

    await client.query('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)', [file, Date.now()]);
  }
}

function createDb(): PostgresJsDatabase<typeof schema> {
  if (DATABASE_URL) {
    const client = postgres(DATABASE_URL, {
      ssl: process.env.NODE_ENV === 'production' ? 'require' : false,
    });
    const pgDb = drizzlePg(client, { schema });
    _migrateFn = migratePg;
    return pgDb;
  }

  // Embedded PGlite (zero-config default)
  const dataDir = process.env.PGLITE_DATA_DIR ?? join(process.cwd(), 'data', 'pglite');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // Remove stale lock from previous crash
  const pidFile = join(dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    try { unlinkSync(pidFile); } catch { /* ok */ }
    logger.info('Removed stale PGlite postmaster.pid');
  }

  try {
    _pgliteClient = new PGlite(dataDir);
  } catch (err) {
    // PGlite data corrupted — attempt recovery by resetting
    logger.error({ err }, 'PGlite failed to open — data may be corrupted, resetting database');
    console.error('\n  ⚠ Database corrupted — resetting. Previous data has been lost.');
    console.error('  To prevent this, avoid kill -9 on the process. Use Ctrl+C for graceful shutdown.\n');
    try {
      rmSync(dataDir, { recursive: true, force: true });
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    } catch { /* ok */ }
    _pgliteClient = new PGlite(dataDir);
  }
  const pgliteDb = drizzlePglite(_pgliteClient, { schema });
  _migrateFn = manualMigratePglite;

  // PGlite's drizzle instance is API-compatible with postgres-js at runtime
  return pgliteDb as unknown as PostgresJsDatabase<typeof schema>;
}


export const db = createDb();

/** Run migrations using the correct migrator for the active database */
export async function runMigrations(migrationsFolder = 'src/db/migrations'): Promise<void> {
  if (_migrateFn) {
    await _migrateFn(db, { migrationsFolder });
  }
}

/** Gracefully close the database connection (flushes PGlite WAL) */
export async function closeDb(): Promise<void> {
  if (_pgliteClient) {
    try {
      await _pgliteClient.close();
      logger.info('PGlite closed gracefully');
    } catch (err) {
      logger.warn({ err }, 'PGlite close error (non-fatal)');
    }
  }
}
