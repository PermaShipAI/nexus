export interface Project {
  id: string;
  name: string;
  slug: string;
  repoKey?: string | null;
}

/** @deprecated Use `Project` instead */
export type PermashipProject = Project;

export interface ProjectRegistry {
  listProjects(orgId: string): Promise<Project[]>;
  resolveProjectId(nameOrSlug: string, orgId: string): Promise<string | undefined>;
  resolveRepoKey(projectId: string, orgId: string): Promise<string | undefined>;
  resolveProjectSlug(projectId: string, orgId: string): Promise<string | undefined>;
}
