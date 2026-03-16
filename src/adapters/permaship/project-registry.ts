import {
  listProjects,
  resolveProjectId,
  resolveRepoKey,
  resolveProjectSlug,
} from '../../permaship/client.js';
import type { ProjectRegistry, PermashipProject } from '../interfaces/project-registry.js';

export class PermashipProjectRegistry implements ProjectRegistry {
  async listProjects(orgId: string): Promise<PermashipProject[]> {
    return listProjects(orgId);
  }

  async resolveProjectId(nameOrSlug: string, orgId: string): Promise<string | undefined> {
    return resolveProjectId(nameOrSlug, orgId);
  }

  async resolveRepoKey(projectId: string, orgId: string): Promise<string | undefined> {
    return resolveRepoKey(projectId, orgId);
  }

  async resolveProjectSlug(projectId: string, orgId: string): Promise<string | undefined> {
    return resolveProjectSlug(projectId, orgId);
  }
}
