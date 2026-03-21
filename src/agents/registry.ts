import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agents } from '../db/schema.js';
import { logger } from '../logger.js';
import type { AgentDefinition, AgentId } from './types.js';

// Use process.cwd() as the anchor for production paths
const PERSONAS_DIR = join(process.cwd(), 'personas');

/** File name → AgentId mapping */
const FILE_TO_ID: Record<string, AgentId> = {
  'ai-agent-ciso.md': 'ciso',
  'ai-agent-qa-manager.md': 'qa-manager',
  'ai-agent-sre.md': 'sre',
  'ai-agent-ux-designer.md': 'ux-designer',
  'ai-agent-agentops.md': 'agentops',
  'ai-agent-finops.md': 'finops',
  'ai-agent-product-manager.md': 'product-manager',
  'ai-agent-release-engineering.md': 'release-engineering',
  'ai-agent-voc.md': 'voc',
  'nexus.md': 'nexus',
  'ai-agent-support.md': 'support',
};

/** Strip boilerplate prefix from persona titles */
function cleanTitle(title: string): string {
  return title.replace(/^AI Agent Job Description \+ Charter\s*—\s*/i, '').trim();
}

/** Extract one-line summary from persona markdown */
function extractSummary(content: string): string {
  const match = content.match(/### One-line summary\n+(.+)/);
  return match?.[1]?.trim() ?? '';
}

/** Load all persona files from disk */
export function loadPersonas(): AgentDefinition[] {
  const files = readdirSync(PERSONAS_DIR).filter((f) => f.endsWith('.md'));
  const definitions: AgentDefinition[] = [];

  for (const file of files) {
    const id = FILE_TO_ID[file];
    if (!id) {
      logger.warn({ file }, 'Unknown persona file, skipping');
      continue;
    }

    const raw = readFileSync(join(PERSONAS_DIR, file), 'utf-8');
    const { data: frontmatter, content } = matter(raw);

    definitions.push({
      id,
      title: cleanTitle((frontmatter.title as string) ?? id),
      summary: extractSummary(content),
      personaMd: content,
    });
  }

  logger.info({ count: definitions.length }, 'Loaded persona definitions');
  return definitions;
}

/** Sync loaded personas into the database */
export async function syncAgentsToDb(definitions: AgentDefinition[]): Promise<void> {
  for (const def of definitions) {
    const existing = await db.select().from(agents).where(eq(agents.id, def.id)).limit(1);

    if (existing.length > 0) {
      await db
        .update(agents)
        .set({
          title: def.title,
          personaMd: def.personaMd,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, def.id));
      logger.debug({ agentId: def.id }, 'Updated agent in DB');
    } else {
      await db.insert(agents).values({
        id: def.id,
        title: def.title,
        personaMd: def.personaMd,
      });
      logger.debug({ agentId: def.id }, 'Inserted agent into DB');
    }
  }

  logger.info({ count: definitions.length }, 'Agent DB sync complete');
}

/** In-memory registry of loaded agent definitions */
let registry: Map<AgentId, AgentDefinition> = new Map();

export function getAgent(id: AgentId): AgentDefinition | undefined {
  return registry.get(id);
}

export function getAllAgents(): AgentDefinition[] {
  return Array.from(registry.values());
}

/** Register an agent at runtime (e.g. imported from external source) */
export function registerAgent(def: AgentDefinition): void {
  registry.set(def.id, def);
}

/** Initialize: load from disk, sync to DB, populate registry */
export async function initializeAgents(): Promise<AgentDefinition[]> {
  const definitions = loadPersonas();
  await syncAgentsToDb(definitions);

  registry = new Map(definitions.map((d) => [d.id, d]));

  // Also load any agents from DB that aren't in persona files (e.g. imported agents restored from backup)
  const dbAgents = await db.select().from(agents);
  for (const row of dbAgents) {
    if (!registry.has(row.id as AgentId)) {
      const def: AgentDefinition = {
        id: row.id as AgentId,
        title: row.title,
        summary: row.title,
        personaMd: row.personaMd,
      };
      registry.set(def.id, def);
      logger.debug({ agentId: def.id }, 'Loaded imported agent from DB');
    }
  }

  return Array.from(registry.values());
}
