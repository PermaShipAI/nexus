// Must set env BEFORE anything is imported
process.env.PERMASHIP_API_URL = 'https://control.permaship.ai/v1/';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  await import('dotenv/config');
  const { db } = await import('../src/db/index.js');
  const { pendingActions } = await import('../src/db/schema.js');
  const { eq, and, isNull, or } = await import('drizzle-orm');
  const { parseArgs } = await import('../src/utils/parse-args.js');
  const { config } = await import('../src/config.js');

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const API_BASE = 'https://control.permaship.ai';

  const proposals = await db.select({
    id: pendingActions.id,
    orgId: pendingActions.orgId,
    agentId: pendingActions.agentId,
    status: pendingActions.status,
    args: pendingActions.args,
  }).from(pendingActions)
    .where(and(
      eq(pendingActions.command, 'create-ticket'),
      or(
        eq(pendingActions.status, 'pending'),
        eq(pendingActions.status, 'approved'),
      ),
      isNull(pendingActions.suggestionId),
    ));

  const valid = proposals.filter(p => {
    const args = parseArgs(p.args);
    const projectId = args['project-id'] as string;
    return projectId && UUID_RE.test(projectId) && !projectId.startsWith('0000') && !projectId.startsWith('2222');
  });

  console.log(`${valid.length} proposals remaining\n`);

  let success = 0;
  let failed = 0;

  for (const p of valid) {
    const args = parseArgs(p.args);
    const projectId = args['project-id'] as string;
    const title = args.title as string;
    const kind = (args.kind as string) ?? 'task';
    const description = (args.description as string) ?? '';
    const repoKey = (args['repo-key'] as string) ?? 'claude-conductor';
    const priority = args.priority ? parseInt(args.priority as string, 10) : undefined;

    process.stdout.write(`${p.agentId} | "${title?.substring(0, 50)}" ... `);

    // Use fetch directly to bypass the client module's cached config
    await sleep(1000);
    try {
      const url = `${API_BASE}/api/internal/orgs/${p.orgId}/projects/${projectId}/suggestions`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': config.PERMASHIP_INTERNAL_SECRET || '',
          'X-Idempotency-Key': `backfill-${p.id}`,
        },
        body: JSON.stringify({ title, kind, description, repoKey, projectId, priority }),
      });

      if (resp.ok) {
        const data = (await resp.json()) as any;
        const suggestionId = data.suggestion?.id;
        if (suggestionId) {
          await db.update(pendingActions)
            .set({ suggestionId })
            .where(eq(pendingActions.id, p.id));
          console.log(`✓ ${suggestionId}`);
          success++;
        } else {
          console.log(`✗ no suggestion ID in response`);
          failed++;
        }
      } else {
        const text = await resp.text();
        console.log(`✗ ${resp.status}: ${text.substring(0, 60)}`);
        failed++;
        if (resp.status === 429 || resp.status === 403) {
          await sleep(5000);
        }
      }
    } catch (err) {
      console.log(`✗ ${err}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} created, ${failed} failed`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
