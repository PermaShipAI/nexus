/**
 * Code exploration tools exposed to the LLM during the tool-use loop.
 * Maps 1:1 to SourceExplorer methods.
 */
import type { LLMFunctionDeclaration } from '../adapters/interfaces/llm-provider.js';
import type { SourceExplorer } from '../adapters/interfaces/source-explorer.js';
import { getProjectRegistry } from '../adapters/registry.js';
import { logger } from '../logger.js';
import { WaitingForHumanError } from './errors.js';

export const CODE_TOOL_DECLARATIONS: LLMFunctionDeclaration[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from a project repository. Returns up to 100KB. Use this to understand implementation details.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or slug (from the Available Projects list)' },
        file_path: { type: 'string', description: 'Path to the file within the repository (e.g. "src/index.ts")' },
      },
      required: ['project', 'file_path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories in a directory. Use this to explore repository structure.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or slug' },
        directory_path: { type: 'string', description: 'Directory path within the repository (default: root ".")' },
      },
      required: ['project'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a text pattern across files in the repository. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or slug' },
        query: { type: 'string', description: 'Text or regex pattern to search for' },
        file_glob: { type: 'string', description: 'Optional glob to restrict search (e.g. "*.ts", "src/**/*.py")' },
      },
      required: ['project', 'query'],
    },
  },
  {
    name: 'get_file_tree',
    description: 'Get the directory tree of the repository. Shows files and folders up to the specified depth.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or slug' },
        max_depth: { type: 'number', description: 'Maximum depth to traverse (default: 3)' },
      },
      required: ['project'],
    },
  },
];

interface CodeToolContext {
  orgId: string;
  explorer: SourceExplorer;
}

/**
 * Resolve a project name/slug to a repoKey using ProjectRegistry.
 */
async function resolveRepoKey(project: string, orgId: string): Promise<string | null> {
  const registry = getProjectRegistry();
  const projectId = await registry.resolveProjectId(project, orgId);
  if (!projectId) return null;
  const repoKey = await registry.resolveRepoKey(projectId, orgId);
  return repoKey ?? null;
}

/**
 * Execute a code tool call and return the result as a string.
 */
export async function executeCodeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: CodeToolContext,
): Promise<string> {
  const project = args.project as string;
  if (!project) return 'Error: "project" parameter is required.';

  const repoKey = await resolveRepoKey(project, ctx.orgId);
  if (!repoKey) return `Error: Project "${project}" not found. Check the Available Projects list.`;

  try {
    switch (name) {
      case 'read_file': {
        const filePath = args.file_path as string;
        if (!filePath) return 'Error: "file_path" parameter is required.';
        const result = await ctx.explorer.readFile(ctx.orgId, repoKey, filePath);
        if (!result) return `File not found or not readable: ${filePath}`;
        const suffix = result.truncated ? '\n\n[... truncated at 100KB]' : '';
        return result.content + suffix;
      }

      case 'list_directory': {
        const dirPath = (args.directory_path as string) ?? '.';
        const result = await ctx.explorer.listDirectory(ctx.orgId, repoKey, dirPath);
        if (!result) return `Directory not found: ${dirPath}`;
        if (result.entries.length === 0) return 'Directory is empty.';
        return result.entries
          .map(e => `${e.type === 'directory' ? '📁' : '📄'} ${e.name}`)
          .join('\n');
      }

      case 'search_code': {
        const query = args.query as string;
        if (!query) return 'Error: "query" parameter is required.';
        const fileGlob = args.file_glob as string | undefined;
        const result = await ctx.explorer.searchCode(ctx.orgId, repoKey, query, { glob: fileGlob, maxResults: 30 });
        if (!result) return 'Search failed.';
        if (result.matches.length === 0) return 'No matches found.';
        return result.matches
          .map(m => `${m.filePath}:${m.lineNumber}: ${m.lineContent}`)
          .join('\n');
      }

      case 'get_file_tree': {
        const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : 3;
        const result = await ctx.explorer.getFileTree(ctx.orgId, repoKey, { maxDepth });
        if (!result) return 'Could not generate file tree.';
        return result.tree || 'Repository appears empty.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    if (err instanceof WaitingForHumanError) throw err; // propagate to loop level
    logger.error({ err, tool: name, project }, 'Code tool execution failed');
    return `Tool error: ${(err as Error).message}`;
  }
}
