import { fetchKnowledgeDocuments } from '../../permaship/client.js';
import type { KnowledgeSource, KnowledgeDocument } from '../interfaces/knowledge-source.js';

export class PermashipKnowledgeSource implements KnowledgeSource {
  async fetchKnowledgeDocuments(
    orgId: string,
    projectId: string,
  ): Promise<KnowledgeDocument[]> {
    return fetchKnowledgeDocuments(orgId, projectId);
  }
}
