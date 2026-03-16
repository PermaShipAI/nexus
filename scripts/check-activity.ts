async function main() {
  await import('dotenv/config');
  const { db } = await import('../src/db/index.js');
  const { pendingActions, workspaceLinks, activityLog } = await import('../src/db/schema.js');
  const { eq, desc, and, gte, sql } = await import('drizzle-orm');
  const { parseArgs } = await import('../src/utils/parse-args.js');

  // Find Voltaire org
  const links = await db.select().from(workspaceLinks);
  console.log('=== Workspace Links ===');
  for (const l of links) {
    console.log(`  org: ${l.orgId} | platform: ${l.platform} | workspace: ${l.workspaceId} | internal channel: ${l.internalChannelId}`);
  }

  // Check recent proposals (last 48h)
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  console.log('\n=== Recent Proposals (last 48h) ===');
  const recentProposals = await db.select({
    id: pendingActions.id,
    orgId: pendingActions.orgId,
    agentId: pendingActions.agentId,
    command: pendingActions.command,
    status: pendingActions.status,
    args: pendingActions.args,
    createdAt: pendingActions.createdAt,
    resolvedAt: pendingActions.resolvedAt,
  }).from(pendingActions)
    .where(gte(pendingActions.createdAt, since48h))
    .orderBy(desc(pendingActions.createdAt))
    .limit(50);

  if (recentProposals.length === 0) {
    console.log('  No proposals in the last 48h');
  }
  for (const p of recentProposals) {
    const args = parseArgs(p.args);
    console.log(`  [${p.createdAt?.toISOString()}] ${p.orgId.substring(0,8)} | ${p.agentId} | ${p.command} | ${p.status} | "${args.title || p.id}"`);
  }

  // Check recent activity log
  console.log('\n=== Recent Activity Log (last 24h) ===');
  const recentActivity = await db.select({
    type: activityLog.type,
    agentId: activityLog.agentId,
    channelId: activityLog.channelId,
    orgId: activityLog.orgId,
    createdAt: activityLog.createdAt,
  }).from(activityLog)
    .where(gte(activityLog.createdAt, since24h))
    .orderBy(desc(activityLog.createdAt))
    .limit(30);

  if (recentActivity.length === 0) {
    console.log('  No activity in the last 24h');
  }
  for (const a of recentActivity) {
    console.log(`  [${a.createdAt?.toISOString()}] ${a.orgId?.substring(0,8)} | ${a.agentId} | ${a.type} | ch:${a.channelId}`);
  }

  // Check last nexus review cycle
  console.log('\n=== Last Nexus Review Cycles ===');
  const nexusActivity = await db.select({
    type: activityLog.type,
    agentId: activityLog.agentId,
    orgId: activityLog.orgId,
    createdAt: activityLog.createdAt,
  }).from(activityLog)
    .where(eq(activityLog.type, 'nexus_review_cycle'))
    .orderBy(desc(activityLog.createdAt))
    .limit(10);

  if (nexusActivity.length === 0) {
    console.log('  No nexus review cycles found');
  }
  for (const a of nexusActivity) {
    console.log(`  [${a.createdAt?.toISOString()}] ${a.orgId?.substring(0,8)} | ${a.agentId}`);
  }

  // Check last agent execution for each org
  console.log('\n=== Last Agent Executions (any type) ===');
  const lastExecs = await db.select({
    type: activityLog.type,
    agentId: activityLog.agentId,
    orgId: activityLog.orgId,
    channelId: activityLog.channelId,
    createdAt: activityLog.createdAt,
  }).from(activityLog)
    .where(eq(activityLog.type, 'agent_execution'))
    .orderBy(desc(activityLog.createdAt))
    .limit(20);

  for (const a of lastExecs) {
    console.log(`  [${a.createdAt?.toISOString()}] ${a.orgId?.substring(0,8)} | ${a.agentId} | ch:${a.channelId}`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
