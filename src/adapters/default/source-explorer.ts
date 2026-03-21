import { readdir, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceExplorer, DirectoryEntry, CodeSearchMatch } from '../interfaces/source-explorer.js';

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_DIR_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 30;
const MAX_TREE_ENTRIES = 500;

const EXCLUDED_NAMES = new Set(['.git', 'node_modules', '.env', '.env.local', '.env.production']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.zip', '.tar', '.gz', '.pdf', '.exe', '.dll', '.so', '.dylib']);

function isBinary(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function isExcluded(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || name.startsWith('.env');
}

/**
 * Filesystem-based SourceExplorer for local development.
 * Resolves repoKey → local path via a constructor-injected resolver function.
 */
export class LocalSourceExplorer implements SourceExplorer {
  private resolveRoot: (repoKey: string) => string | null;

  constructor(resolveRoot: (repoKey: string) => string | null) {
    this.resolveRoot = resolveRoot;
  }

  private getRoot(repoKey: string): string | null {
    return this.resolveRoot(repoKey);
  }

  private validatePath(root: string, filePath: string): string | null {
    const resolved = resolve(root, filePath);
    // Ensure the resolved path stays under root
    if (!resolved.startsWith(root + '/') && resolved !== root) return null;
    // Check excluded segments
    const rel = relative(root, resolved);
    const parts = rel.split('/');
    for (const part of parts) {
      if (isExcluded(part)) return null;
    }
    return resolved;
  }

  async readFile(orgId: string, repoKey: string, filePath: string): Promise<{ content: string; truncated: boolean } | null> {
    const root = this.getRoot(repoKey);
    if (!root) return null;
    const fullPath = this.validatePath(root, filePath);
    if (!fullPath) return null;
    if (isBinary(filePath)) return null;

    try {
      const info = await stat(fullPath);
      if (!info.isFile()) return null;
      const buf = Buffer.alloc(Math.min(info.size, MAX_FILE_SIZE));
      const fh = await (await import('node:fs/promises')).open(fullPath, 'r');
      try {
        await fh.read(buf, 0, buf.length, 0);
      } finally {
        await fh.close();
      }
      const content = buf.toString('utf-8');
      return { content, truncated: info.size > MAX_FILE_SIZE };
    } catch {
      return null;
    }
  }

  async listDirectory(orgId: string, repoKey: string, dirPath: string): Promise<{ entries: DirectoryEntry[] } | null> {
    const root = this.getRoot(repoKey);
    if (!root) return null;
    const fullPath = this.validatePath(root, dirPath);
    if (!fullPath) return null;

    try {
      const dirents = await readdir(fullPath, { withFileTypes: true });
      const entries: DirectoryEntry[] = [];
      for (const d of dirents) {
        if (isExcluded(d.name)) continue;
        if (entries.length >= MAX_DIR_ENTRIES) break;
        entries.push({
          name: d.name,
          type: d.isDirectory() ? 'directory' : 'file',
        });
      }
      return { entries };
    } catch {
      return null;
    }
  }

  async searchCode(orgId: string, repoKey: string, query: string, options?: { glob?: string; maxResults?: number }): Promise<{ matches: CodeSearchMatch[] } | null> {
    const root = this.getRoot(repoKey);
    if (!root) return null;
    const maxResults = Math.min(options?.maxResults ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);

    try {
      const args = ['-rn', '--max-count', String(maxResults)];
      if (options?.glob) {
        args.push('--include', options.glob);
      }
      // Exclude common directories
      args.push('--exclude-dir=.git', '--exclude-dir=node_modules');
      args.push('--', query, '.');

      const { stdout } = await execFileAsync('grep', args, { cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024 });
      const matches: CodeSearchMatch[] = [];
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        // Format: ./path/to/file:lineNum:content
        const m = line.match(/^\.\/(.+?):(\d+):(.*)$/);
        if (m && matches.length < maxResults) {
          matches.push({ filePath: m[1], lineNumber: parseInt(m[2], 10), lineContent: m[3] });
        }
      }
      return { matches };
    } catch (err) {
      // grep returns exit code 1 when no matches — that's normal
      const e = err as { code?: number };
      if (e.code === 1) return { matches: [] };
      return null;
    }
  }

  async getFileTree(orgId: string, repoKey: string, options?: { maxDepth?: number }): Promise<{ tree: string } | null> {
    const root = this.getRoot(repoKey);
    if (!root) return null;
    const maxDepth = options?.maxDepth ?? 3;

    try {
      const lines: string[] = [];
      await walkTree(root, root, '', maxDepth, lines);
      return { tree: lines.join('\n') };
    } catch {
      return null;
    }
  }
}

async function walkTree(root: string, dir: string, prefix: string, depth: number, lines: string[]): Promise<void> {
  if (depth <= 0 || lines.length >= MAX_TREE_ENTRIES) return;
  const dirents = await readdir(dir, { withFileTypes: true });
  dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const d of dirents) {
    if (lines.length >= MAX_TREE_ENTRIES) break;
    if (isExcluded(d.name)) continue;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) {
      lines.push(`${rel}/`);
      await walkTree(root, join(dir, d.name), rel, depth - 1, lines);
    } else {
      lines.push(rel);
    }
  }
}
