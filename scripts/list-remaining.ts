process.env.PERMASHIP_API_URL = 'https://control.permaship.ai/v1/';

async function main() {
  await import('dotenv/config');
  const { db } = await import('../src/db/index.js');
  const { pendingActions } = await import('../src/db/schema.js');
  const { eq, and, isNull, or } = await import('drizzle-orm');
  const { parseArgs } = await import('../src/utils/parse-args.js');

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const proposals = await db.select({
    id: pendingActions.id, orgId: pendingActions.orgId, args: pendingActions.args, agentId: pendingActions.agentId,
  }).from(pendingActions).where(and(
    eq(pendingActions.command, 'create-ticket'),
    or(eq(pendingActions.status, 'pending'), eq(pendingActions.status, 'approved')),
    isNull(pendingActions.suggestionId),
  ));

  const valid = proposals.filter(p => {
    const args = parseArgs(p.args);
    const pid = args['project-id'] as string;
    return pid && UUID_RE.test(pid) && !pid.startsWith('0000') && !pid.startsWith('2222');
  });

  console.log(`${valid.length} remaining:`);
  for (const p of valid) {
    const args = parseArgs(p.args);
    console.log(JSON.stringify({
      id: p.id,
      org: p.orgId,
      agent: p.agentId,
      projectId: args['project-id'],
      title: args.title,
      kind: args.kind,
      repoKey: args['repo-key'],
      description: (args.description as string)?.substring(0, 100),
    }));
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
