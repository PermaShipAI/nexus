/**
 * Repo Indexer — generates knowledge entries from repository contents.
 *
 * When a GitHub App installation grants access to repos, this module:
 * 1. Fetches the file tree via SourceExplorer
 * 2. Reads key files (README, configs, entry points)
 * 3. Generates a structured repo profile via LLM
 * 4. Stores results as knowledge entries for agent context injection
 */
import { eq, and, like } from 'drizzle-orm';
import { db } from '../db/index.js';
import { knowledgeEntries } from '../db/schema.js';
import { getSourceExplorer, getLLMProvider } from '../adapters/registry.js';
import { logger } from '../logger.js';

const REPO_SOURCE_PREFIX = 'repo:';

/** Key files to read for repo profiling (checked in order, first 10 found are read) */
const KEY_FILE_CANDIDATES = [
  'README.md',
  'readme.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'tsconfig.json',
  '.github/workflows/ci.yml',
  '.github/workflows/ci.yaml',
  '.github/workflows/main.yml',
  'CONTRIBUTING.md',
  'CLAUDE.md',
  'src/index.ts',
  'src/main.ts',
  'src/app.ts',
  'src/index.js',
  'main.py',
  'app.py',
  'src/main.rs',
  'main.go',
  'cmd/main.go',
];

const MAX_KEY_FILES = 10;
const MAX_FILE_CONTENT_FOR_PROFILE = 4000; // chars per file, to stay within context limits

function repoSourceId(repoKey: string): string {
  return `${REPO_SOURCE_PREFIX}${repoKey}`;
}

function treeSourceId(repoKey: string): string {
  return `${REPO_SOURCE_PREFIX}${repoKey}:tree`;
}

/**
 * Index a single repo: fetch tree, read key files, generate profile, store as knowledge.
 */
export async function indexRepo(orgId: string, repoKey: string): Promise<void> {
  const explorer = getSourceExplorer();
  if (!explorer) {
    logger.warn({ orgId, repoKey }, 'No SourceExplorer available, skipping repo indexing');
    return;
  }

  logger.info({ orgId, repoKey }, 'Starting repo indexing');

  // 1. Fetch file tree
  let tree: string | null = null;
  try {
    const treeResult = await explorer.getFileTree(orgId, repoKey, { maxDepth: 3 });
    tree = treeResult?.tree ?? null;
  } catch (err) {
    logger.error({ err, orgId, repoKey }, 'Failed to fetch file tree');
  }

  // Store file tree as knowledge entry
  if (tree) {
    await upsertKnowledgeEntry(orgId, treeSourceId(repoKey), `[File Tree] ${repoKey}`, tree);
  }

  // 2. Read key files
  const keyFileContents: Array<{ path: string; content: string }> = [];
  const treeLines = tree ? tree.split('\n') : [];

  for (const candidate of KEY_FILE_CANDIDATES) {
    if (keyFileContents.length >= MAX_KEY_FILES) break;

    // Check if the file exists in the tree (if we have it)
    const exists = treeLines.length === 0 || treeLines.some((line) => line === candidate || line.endsWith(`/${candidate}`));
    if (!exists && treeLines.length > 0) continue;

    try {
      const result = await explorer.readFile(orgId, repoKey, candidate);
      if (result?.content) {
        const truncated =
          result.content.length > MAX_FILE_CONTENT_FOR_PROFILE
            ? result.content.slice(0, MAX_FILE_CONTENT_FOR_PROFILE) + '\n[...truncated]'
            : result.content;
        keyFileContents.push({ path: candidate, content: truncated });
      }
    } catch {
      // File not found or not readable — skip silently
    }
  }

  // 3. Generate repo profile via LLM
  if (keyFileContents.length === 0 && !tree) {
    logger.warn({ orgId, repoKey }, 'No files or tree found, skipping profile generation');
    return;
  }

  const profilePrompt = buildProfilePrompt(repoKey, tree, keyFileContents);
  let profile: string;

  try {
    profile = await getLLMProvider().generateText({
      model: 'ROUTER', // Use lighter model for summarization
      orgId,
      systemInstruction:
        'You are a technical analyst. Summarize repository structure and purpose concisely. Focus on: language/framework, architecture, key entry points, test infrastructure, CI/CD setup, and notable patterns. Keep output under 1500 words.',
      contents: [{ role: 'user', parts: [{ text: profilePrompt }] }],
    });
  } catch (err) {
    logger.error({ err, orgId, repoKey }, 'Failed to generate repo profile');
    // Fall back to a basic profile from the raw data
    profile = buildFallbackProfile(repoKey, tree, keyFileContents);
  }

  // 4. Store repo profile as knowledge entry
  await upsertKnowledgeEntry(orgId, repoSourceId(repoKey), `[Repo Profile] ${repoKey}`, profile);

  logger.info(
    { orgId, repoKey, keyFilesRead: keyFileContents.length, profileLength: profile.length },
    'Repo indexing complete',
  );
}

/**
 * Index all repos for an org. Errors per-repo don't block others.
 */
export async function indexAllRepos(
  orgId: string,
  repos: Array<{ id: number; fullName: string }>,
): Promise<void> {
  logger.info({ orgId, repoCount: repos.length }, 'Starting bulk repo indexing');

  for (const repo of repos) {
    try {
      await indexRepo(orgId, repo.fullName);
    } catch (err) {
      logger.error({ err, orgId, repoKey: repo.fullName }, 'Failed to index repo (continuing)');
    }
  }

  logger.info({ orgId, repoCount: repos.length }, 'Bulk repo indexing complete');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function upsertKnowledgeEntry(
  orgId: string,
  sourceId: string,
  topic: string,
  content: string,
): Promise<void> {
  // Generate embedding
  let embedding: number[] | null = null;
  try {
    embedding = await getLLMProvider().embedText(`${topic}: ${content.slice(0, 500)}`);
  } catch {
    // Embedding optional — continue without it
  }

  const [existing] = await db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.sourceId, sourceId), eq(knowledgeEntries.orgId, orgId)))
    .limit(1);

  if (existing) {
    if (existing.content === content) return; // No change

    await db
      .update(knowledgeEntries)
      .set({ topic, content, embedding, updatedAt: new Date() })
      .where(eq(knowledgeEntries.id, existing.id));
    logger.debug({ sourceId, topic }, 'Repo index: updated entry');
  } else {
    await db.insert(knowledgeEntries).values({
      orgId,
      kind: 'shared',
      topic,
      content,
      sourceId,
      embedding,
    });
    logger.debug({ sourceId, topic }, 'Repo index: created entry');
  }
}

function buildProfilePrompt(
  repoKey: string,
  tree: string | null,
  files: Array<{ path: string; content: string }>,
): string {
  const sections: string[] = [`Analyze the repository "${repoKey}" and produce a concise profile.`, ''];

  if (tree) {
    sections.push('## File Tree (depth 3)', '```', tree.slice(0, 3000), '```', '');
  }

  for (const file of files) {
    sections.push(`## ${file.path}`, '```', file.content, '```', '');
  }

  sections.push(
    'Produce a structured profile covering:',
    '1. **Language & Framework**: Primary language, framework, runtime',
    '2. **Architecture**: How the code is organized, key directories',
    '3. **Entry Points**: Main files, CLI commands, server startup',
    '4. **Dependencies**: Notable libraries and their purpose',
    '5. **Testing**: Test framework, test location, coverage approach',
    '6. **CI/CD**: Build system, deployment approach',
    '7. **Notable Patterns**: Anything distinctive about this codebase',
  );

  return sections.join('\n');
}

function buildFallbackProfile(
  repoKey: string,
  tree: string | null,
  files: Array<{ path: string; content: string }>,
): string {
  const sections: string[] = [`# Repo Profile: ${repoKey}`, ''];

  if (tree) {
    sections.push('## File Structure', '```', tree.slice(0, 2000), '```', '');
  }

  if (files.length > 0) {
    sections.push(`## Key Files: ${files.map((f) => f.path).join(', ')}`, '');
  }

  return sections.join('\n');
}
