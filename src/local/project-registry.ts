import { eq, and, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { localProjects } from '../db/schema.js';
import { logger } from '../logger.js';
import type { ProjectRegistry, PermashipProject } from '../adapters/interfaces/project-registry.js';

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export class LocalProjectRegistry implements ProjectRegistry {
  async listProjects(orgId: string): Promise<PermashipProject[]> {
    const rows = await db
      .select()
      .from(localProjects)
      .where(and(eq(localProjects.orgId, orgId), eq(localProjects.cloneStatus, 'ready')));

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      repoKey: r.repoKey,
    }));
  }

  async resolveProjectId(nameOrSlug: string, orgId: string): Promise<string | undefined> {
    const lower = nameOrSlug.toLowerCase().trim();

    // Exact match on slug or name (case-insensitive)
    const [match] = await db
      .select({ id: localProjects.id })
      .from(localProjects)
      .where(
        and(
          eq(localProjects.orgId, orgId),
          ilike(localProjects.name, lower),
        ),
      )
      .limit(1);

    if (match) return match.id;

    // Try slug match
    const [slugMatch] = await db
      .select({ id: localProjects.id })
      .from(localProjects)
      .where(and(eq(localProjects.orgId, orgId), eq(localProjects.slug, lower)))
      .limit(1);

    return slugMatch?.id;
  }

  async resolveRepoKey(projectId: string, orgId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ repoKey: localProjects.repoKey })
      .from(localProjects)
      .where(and(eq(localProjects.id, projectId), eq(localProjects.orgId, orgId)))
      .limit(1);
    return row?.repoKey;
  }

  async resolveProjectSlug(projectId: string, orgId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ slug: localProjects.slug })
      .from(localProjects)
      .where(and(eq(localProjects.id, projectId), eq(localProjects.orgId, orgId)))
      .limit(1);
    return row?.slug;
  }

  // ── CRUD helpers (not part of the interface, used by API routes) ──────

  async addProject(
    orgId: string,
    name: string,
    localPath: string,
    sourceType: 'local' | 'git',
    remoteUrl?: string,
  ): Promise<{ id: string; slug: string }> {
    const slug = toSlug(name);
    const repoKey = slug;

    const [row] = await db.insert(localProjects).values({
      orgId,
      name,
      slug,
      sourceType,
      localPath,
      remoteUrl: remoteUrl ?? null,
      repoKey,
      cloneStatus: sourceType === 'git' ? 'cloning' : 'ready',
    }).returning({ id: localProjects.id, slug: localProjects.slug });

    logger.info({ projectId: row.id, name, slug, sourceType }, 'Local project added');
    return row;
  }

  async removeProject(projectId: string, orgId: string): Promise<boolean> {
    const deleted = await db
      .delete(localProjects)
      .where(and(eq(localProjects.id, projectId), eq(localProjects.orgId, orgId)))
      .returning({ id: localProjects.id });
    return deleted.length > 0;
  }

  async getProjectLocalPath(projectId: string, orgId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ localPath: localProjects.localPath })
      .from(localProjects)
      .where(and(eq(localProjects.id, projectId), eq(localProjects.orgId, orgId)))
      .limit(1);
    return row?.localPath;
  }

  async getProjectByRepoKey(repoKey: string, orgId: string): Promise<{ localPath: string } | undefined> {
    const [row] = await db
      .select({ localPath: localProjects.localPath })
      .from(localProjects)
      .where(and(eq(localProjects.repoKey, repoKey), eq(localProjects.orgId, orgId)))
      .limit(1);
    return row ? { localPath: row.localPath } : undefined;
  }

  async updateCloneStatus(projectId: string, status: string, error?: string): Promise<void> {
    await db
      .update(localProjects)
      .set({ cloneStatus: status, cloneError: error ?? null, updatedAt: new Date() })
      .where(eq(localProjects.id, projectId));
  }

  async getAllProjects(orgId: string) {
    return db.select().from(localProjects).where(eq(localProjects.orgId, orgId));
  }
}
