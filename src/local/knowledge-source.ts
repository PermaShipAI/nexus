import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import type { KnowledgeSource, KnowledgeDocument } from '../adapters/interfaces/knowledge-source.js';
import { LocalProjectRegistry } from './project-registry.js';

const MAX_DOC_SIZE = 50_000; // 50KB per document

function stableId(projectId: string, relativePath: string): string {
  return createHash('sha256').update(`${projectId}:${relativePath}`).digest('hex').slice(0, 32);
}

export class LocalFileKnowledgeSource implements KnowledgeSource {
  constructor(private registry: LocalProjectRegistry) {}

  async fetchKnowledgeDocuments(
    orgId: string,
    projectId: string,
  ): Promise<KnowledgeDocument[]> {
    const localPath = await this.registry.getProjectLocalPath(projectId, orgId);
    if (!localPath) return [];

    const docs: KnowledgeDocument[] = [];

    // Read README.md
    try {
      const readmePath = join(localPath, 'README.md');
      const content = await readFile(readmePath, 'utf-8');
      const st = await stat(readmePath);
      docs.push({
        id: stableId(projectId, 'README.md'),
        title: 'README',
        content: content.slice(0, MAX_DOC_SIZE),
        version: Math.floor(st.mtimeMs),
        updatedAt: st.mtime.toISOString(),
      });
    } catch {
      // No README — fine
    }

    // Scan docs/ directory for *.md files (depth-1)
    try {
      const docsDir = join(localPath, 'docs');
      const entries = await readdir(docsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name) !== '.md') continue;

        try {
          const filePath = join(docsDir, entry.name);
          const content = await readFile(filePath, 'utf-8');
          const st = await stat(filePath);
          const title = basename(entry.name, '.md').replace(/[-_]/g, ' ');

          docs.push({
            id: stableId(projectId, `docs/${entry.name}`),
            title,
            content: content.slice(0, MAX_DOC_SIZE),
            version: Math.floor(st.mtimeMs),
            updatedAt: st.mtime.toISOString(),
          });
        } catch (err) {
          logger.warn({ err, file: entry.name }, 'Failed to read doc file');
        }
      }
    } catch {
      // No docs/ directory — fine
    }

    logger.debug({ projectId, docCount: docs.length }, 'Local knowledge documents loaded');
    return docs;
  }
}
