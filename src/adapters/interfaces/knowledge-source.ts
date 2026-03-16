export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  version: number;
  updatedAt: string;
}

export interface KnowledgeSource {
  fetchKnowledgeDocuments(
    orgId: string,
    projectId: string,
  ): Promise<KnowledgeDocument[]>;
}
