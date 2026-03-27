// src/idle/policy-resolver.ts — Resolve effective policy for a project

import { db } from '../db/index.js';
import { localProjects } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getSetting } from '../settings/service.js';
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

/** Update a project's policy */
export async function setProjectPolicy(orgId: string, projectId: string, policy: ProjectPolicy): Promise<void> {
  await db
    .update(localProjects)
    .set({ policy, updatedAt: new Date() })
    .where(and(eq(localProjects.id, projectId), eq(localProjects.orgId, orgId)));
}

/** Get all projects with their resolved policies */
export async function getAllProjectPolicies(orgId: string): Promise<Array<{
  id: string;
  name: string;
  slug: string;
  policy: ProjectPolicy;
}>> {
  const rows = await db
    .select({
      id: localProjects.id,
      name: localProjects.name,
      slug: localProjects.slug,
      policy: localProjects.policy,
      cloneStatus: localProjects.cloneStatus,
    })
    .from(localProjects)
    .where(and(eq(localProjects.orgId, orgId), eq(localProjects.cloneStatus, 'ready')));

  const orgDefault = await getSetting('default_project_policy', orgId) as ProjectPolicy | null;

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    policy: (r.policy as ProjectPolicy)?.focusLevel
      ? { ...DEFAULT_PROJECT_POLICY, ...(r.policy as ProjectPolicy) }
      : orgDefault?.focusLevel
        ? { ...DEFAULT_PROJECT_POLICY, ...orgDefault }
        : DEFAULT_PROJECT_POLICY,
  }));
}
