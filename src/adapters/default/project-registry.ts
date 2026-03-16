import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectRegistry, PermashipProject } from '../interfaces/project-registry.js';

interface ProjectConfig {
  id: string;
  name: string;
  slug: string;
  repoKey?: string;
}

/**
 * File-based project registry for standalone use.
 * Reads projects from a projects.json file in the working directory.
 */
export class LocalProjectRegistry implements ProjectRegistry {
  private projects: ProjectConfig[] | null = null;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? resolve(process.cwd(), 'projects.json');
  }

  private async load(): Promise<ProjectConfig[]> {
    if (this.projects) return this.projects;
    try {
      const raw = await readFile(this.configPath, 'utf-8');
      this.projects = JSON.parse(raw) as ProjectConfig[];
    } catch {
      this.projects = [];
    }
    return this.projects;
  }

  async listProjects(_orgId: string): Promise<PermashipProject[]> {
    const projects = await this.load();
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      repoKey: p.repoKey ?? null,
    }));
  }

  async resolveProjectId(nameOrSlug: string, _orgId: string): Promise<string | undefined> {
    const projects = await this.load();
    const lower = nameOrSlug.toLowerCase();
    const match = projects.find(
      (p) => p.name.toLowerCase() === lower || p.slug.toLowerCase() === lower,
    );
    return match?.id;
  }

  async resolveRepoKey(projectId: string, _orgId: string): Promise<string | undefined> {
    const projects = await this.load();
    return projects.find((p) => p.id === projectId)?.repoKey;
  }

  async resolveProjectSlug(projectId: string, _orgId: string): Promise<string | undefined> {
    const projects = await this.load();
    return projects.find((p) => p.id === projectId)?.slug;
  }
}
