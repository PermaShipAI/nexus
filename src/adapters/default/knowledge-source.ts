import { readdir, readFile } from 'node:fs/promises';
import { resolve, basename, extname } from 'node:path';
import type { KnowledgeSource, KnowledgeDocument } from '../interfaces/knowledge-source.js';

/**
 * File-based knowledge source for standalone use.
 * Reads markdown files from a local knowledge directory.
 */
export class FileKnowledgeSource implements KnowledgeSource {
  private knowledgeDir: string;

  constructor(knowledgeDir?: string) {
    this.knowledgeDir = knowledgeDir ?? resolve(process.cwd(), 'knowledge');
  }

  async fetchKnowledgeDocuments(
    _orgId: string,
    _projectId: string,
  ): Promise<KnowledgeDocument[]> {
    try {
      const files = await readdir(this.knowledgeDir);
      const docs: KnowledgeDocument[] = [];

      for (const file of files) {
        if (extname(file) !== '.md') continue;
        const filePath = resolve(this.knowledgeDir, file);
        const content = await readFile(filePath, 'utf-8');
        docs.push({
          id: file,
          title: basename(file, '.md'),
          content,
          version: 1,
          updatedAt: new Date().toISOString(),
        });
      }

      return docs;
    } catch {
      return [];
    }
  }
}
