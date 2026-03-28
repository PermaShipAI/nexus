// src/idle/policy-resolver.ts — Resolve effective policy for a project

import { db } from '../db/index.js';
import { localProjects } from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { getSetting } from '../settings/service.js';
import { getProjectRegistry } from '../adapters/registry.js';
import { logger } from '../logger.js';
import {
  type ProjectPolicy,
  type OperatingWindow,
  DEFAULT_PROJECT_POLICY,
} from './project-policy.js';

/**
 * Resolution order:
 * 1. project-level `local_projects.policy`
 * 2. org default from `bot_settings` key `default_project_policy`
 * 3. hardcoded `DEFAULT_PROJECT_POLICY`
 */
export async function resolveProjectPolicy(orgId: string, projectId: string): Promise<ProjectPolicy> {
  try {
    // 1. Project-level policy
    const [row] = await db
      .select({ policy: localProjects.policy })
      .from(localProjects)
      .where(and(eq(localProjects.id, projectId), eq(localProjects.orgId, orgId)))
      .limit(1);

    if (row?.policy) {
      const policy = row.policy as ProjectPolicy;
      if (policy.focusLevel) return { ...DEFAULT_PROJECT_POLICY, ...policy };
    }

    // 2. Org-level default
    const orgDefault = await getSetting('default_project_policy', orgId) as ProjectPolicy | null;
    if (orgDefault?.focusLevel) {
      return { ...DEFAULT_PROJECT_POLICY, ...orgDefault };
    }
  } catch (err) {
    logger.warn({ err, orgId, projectId }, 'Failed to resolve project policy, using default');
  }

  // 3. Hardcoded default
  return DEFAULT_PROJECT_POLICY;
}

/**
 * Resolve operating window for a project.
 * Resolution order:
 * 1. project policy operatingWindow
 * 2. org-level `org_operating_window` setting
 * 3. null (no restriction)
 */
export async function resolveOperatingWindow(orgId: string, projectId: string): Promise<OperatingWindow | null> {
  try {
    const policy = await resolveProjectPolicy(orgId, projectId);
    if (policy.operatingWindow !== undefined) {
      return policy.operatingWindow;
    }

    const orgWindow = await getSetting('org_operating_window', orgId) as OperatingWindow | null;
    if (orgWindow) return orgWindow;
  } catch (err) {
    logger.warn({ err, orgId, projectId }, 'Failed to resolve operating window');
  }

  return null;
}

/** Update a project's policy. Creates a local_projects row if it doesn't exist
 * (production projects come from the adapter registry, not from local_projects).
 */
export async function setProjectPolicy(orgId: string, projectId: string, policy: ProjectPolicy): Promise<void> {
  const [existing] = await db
    .select({ id: localProjects.id })
    .from(localProjects)
    .where(and(eq(localProjects.id, projectId), eq(localProjects.orgId, orgId)))
    .limit(1);

  if (existing) {
    await db
      .update(localProjects)
      .set({ policy, updatedAt: new Date() })
      .where(and(eq(localProjects.id, projectId), eq(localProjects.orgId, orgId)));
  } else {
    // Create a minimal row for policy storage — project details come from the registry
    const registry = getProjectRegistry();
    const projects = await registry.listProjects(orgId);
    const project = projects.find(p => p.id === projectId);
    const name = project?.name ?? 'unknown';
    const slug = project?.slug ?? projectId.slice(0, 8);

    await db.insert(localProjects).values({
      id: projectId,
      orgId,
      name,
      slug,
      sourceType: 'git',
      localPath: '',
      repoKey: slug,
      cloneStatus: 'ready',
      policy,
    });
  }
}

/** Get all projects with their resolved policies.
 * Uses the adapter's ProjectRegistry for project discovery, then looks up
 * any stored policies from the local_projects table.
 */
export async function getAllProjectPolicies(orgId: string): Promise<Array<{
  id: string;
  name: string;
  slug: string;
  policy: ProjectPolicy;
}>> {
  const registry = getProjectRegistry();
  const projects = await registry.listProjects(orgId);
  if (projects.length === 0) return [];

  // Batch-fetch any stored policies from local_projects
  const projectIds = projects.map(p => p.id);
  const policyRows = await db
    .select({ id: localProjects.id, policy: localProjects.policy })
    .from(localProjects)
    .where(and(eq(localProjects.orgId, orgId), inArray(localProjects.id, projectIds)));

  const policyMap = new Map(policyRows.map(r => [r.id, r.policy as ProjectPolicy | null]));

  const orgDefault = await getSetting('default_project_policy', orgId) as ProjectPolicy | null;

  return projects.map(p => {
    const stored = policyMap.get(p.id);
    const policy = stored?.focusLevel
      ? { ...DEFAULT_PROJECT_POLICY, ...stored }
      : orgDefault?.focusLevel
        ? { ...DEFAULT_PROJECT_POLICY, ...orgDefault }
        : DEFAULT_PROJECT_POLICY;

    return { id: p.id, name: p.name, slug: p.slug, policy };
  });
}
