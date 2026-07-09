import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';

export function loadEnvFiles(cwd = process.cwd()): void {
  loadDotenv({ path: join(cwd, '.env') });
  loadDotenv({ path: join(cwd, 'config', '.env') });
}

loadEnvFiles();
