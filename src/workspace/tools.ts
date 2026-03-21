/**
 * Deep research tool declarations and executors.
 * These tools operate on a cloned local workspace and include git-based tools.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LLMFunctionDeclaration } from '../adapters/interfaces/llm-provider.js';

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 100 * 1024;
const TOOL_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 50 * 1024; // 50KB output cap

const EXCLUDED_NAMES = new Set(['.git', 'node_modules', '.env', '.env.local', '.env.production']);

function isExcluded(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || name.startsWith('.env');
}

function validatePath(root: string, filePath: string): string | null {
  const resolved = resolve(root, filePath);
  if (!resolved.startsWith(root + '/') && resolved !== root) return null;
  const rel = relative(root, resolved);
  for (const part of rel.split('/')) {
    if (isExcluded(part)) return null;
  }
  return resolved;
}

function truncate(text: string, max: number = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n[... truncated]';
}

export const DEEP_TOOL_DECLARATIONS: LLMFunctionDeclaration[] = [
  {
    name: 'read_file',
    description: 'Read a file from the repository.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relative to repository root' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a text pattern across repository files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regex to search for' },
        file_glob: { type: 'string', description: 'Optional glob filter (e.g. "*.ts")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories in a directory.',
    parameters: {
      type: 'object',
      properties: {
        directory_path: { type: 'string', description: 'Directory path (default: root ".")' },
      },
    },
  },
  {
    name: 'find_files',
    description: 'Find files matching a glob pattern in the repository.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/auth*")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_log',
    description: 'Show recent git commit history.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of commits to show (default: 20)' },
        path: { type: 'string', description: 'Optional file/directory path to filter history' },
      },
    },
  },
  {
    name: 'git_diff',
    description: 'Show git diff between two references or for a specific path.',
    parameters: {
      type: 'object',
      properties: {
        ref1: { type: 'string', description: 'Start reference (commit SHA, branch, tag)' },
        ref2: { type: 'string', description: 'End reference (default: HEAD)' },
        path: { type: 'string', description: 'Optional file path to restrict diff' },
      },
      required: ['ref1'],
    },
  },
  {
    name: 'git_blame',
    description: 'Show line-by-line authorship for a file or range of lines.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File to blame' },
        start_line: { type: 'number', description: 'Start line number (optional)' },
        end_line: { type: 'number', description: 'End line number (optional)' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'file_info',
    description: 'Get file metadata (size, last modified date).',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file' },
      },
      required: ['file_path'],
    },
  },
];

/**
 * Execute a deep research tool against a local workspace path.
 */
export async function executeDeepTool(
  name: string,
  args: Record<string, unknown>,
  repoPath: string,
): Promise<string> {
  try {
    switch (name) {
      case 'read_file': {
        const filePath = args.file_path as string;
        if (!filePath) return 'Error: file_path is required';
        const fullPath = validatePath(repoPath, filePath);
        if (!fullPath) return 'Error: invalid path';
        const info = await stat(fullPath);
        if (!info.isFile()) return 'Error: not a file';
        const content = await readFile(fullPath, 'utf-8');
        return truncate(content, MAX_FILE_SIZE);
      }

      case 'search_code': {
        const query = args.query as string;
        if (!query) return 'Error: query is required';
        const grepArgs = ['-rn', '--max-count', '30', '--exclude-dir=.git', '--exclude-dir=node_modules'];
        if (args.file_glob) grepArgs.push('--include', args.file_glob as string);
        grepArgs.push('--', query, '.');
        try {
          const { stdout } = await execFileAsync('grep', grepArgs, { cwd: repoPath, timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
          return truncate(stdout);
        } catch (err) {
          if ((err as { code?: number }).code === 1) return 'No matches found.';
          throw err;
        }
      }

      case 'list_directory': {
        const dirPath = (args.directory_path as string) ?? '.';
        const fullPath = validatePath(repoPath, dirPath);
        if (!fullPath) return 'Error: invalid path';
        const dirents = await readdir(fullPath, { withFileTypes: true });
        const lines: string[] = [];
        for (const d of dirents) {
          if (isExcluded(d.name)) continue;
          if (lines.length >= 200) break;
          lines.push(`${d.isDirectory() ? 'd' : 'f'} ${d.name}`);
        }
        return lines.join('\n') || 'Directory is empty.';
      }

      case 'find_files': {
        const pattern = args.pattern as string;
        if (!pattern) return 'Error: pattern is required';
        try {
          const { stdout } = await execFileAsync('git', ['ls-files', '--', pattern], { cwd: repoPath, timeout: TOOL_TIMEOUT_MS });
          const files = stdout.trim().split('\n').filter(Boolean).slice(0, 200);
          return files.join('\n') || 'No files matched.';
        } catch {
          return 'Error: find_files failed';
        }
      }

      case 'git_log': {
        const count = Math.min(typeof args.count === 'number' ? args.count : 20, 50);
        const gitArgs = ['log', '--oneline', `-${count}`];
        if (args.path) {
          const safePath = validatePath(repoPath, args.path as string);
          if (safePath) gitArgs.push('--', args.path as string);
        }
        const { stdout } = await execFileAsync('git', gitArgs, { cwd: repoPath, timeout: TOOL_TIMEOUT_MS });
        return truncate(stdout);
      }

      case 'git_diff': {
        const ref1 = args.ref1 as string;
        if (!ref1) return 'Error: ref1 is required';
        const ref2 = (args.ref2 as string) ?? 'HEAD';
        const gitArgs = ['diff', `${ref1}..${ref2}`];
        if (args.path) {
          const safePath = validatePath(repoPath, args.path as string);
          if (safePath) gitArgs.push('--', args.path as string);
        }
        const { stdout } = await execFileAsync('git', gitArgs, { cwd: repoPath, timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
        return truncate(stdout);
      }

      case 'git_blame': {
        const filePath = args.file_path as string;
        if (!filePath) return 'Error: file_path is required';
        const safePath = validatePath(repoPath, filePath);
        if (!safePath) return 'Error: invalid path';
        const gitArgs = ['blame'];
        if (typeof args.start_line === 'number' && typeof args.end_line === 'number') {
          gitArgs.push('-L', `${args.start_line},${args.end_line}`);
        }
        gitArgs.push('--', filePath);
        const { stdout } = await execFileAsync('git', gitArgs, { cwd: repoPath, timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
        return truncate(stdout);
      }

      case 'file_info': {
        const filePath = args.file_path as string;
        if (!filePath) return 'Error: file_path is required';
        const fullPath = validatePath(repoPath, filePath);
        if (!fullPath) return 'Error: invalid path';
        const info = await stat(fullPath);
        return `Size: ${info.size} bytes\nModified: ${info.mtime.toISOString()}\nType: ${info.isDirectory() ? 'directory' : 'file'}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${(err as Error).message}`;
  }
}
