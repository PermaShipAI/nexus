async function main() {
  await import('dotenv/config');
  const { db } = await import('../src/db/index.js');
  const { workspaceLinks } = await import('../src/db/schema.js');
  const { sql } = await import('drizzle-orm');

  // Check all workspace links
  const links = await db.select().from(workspaceLinks);
  console.log(`Total workspace links: ${links.length}`);
  for (const l of links) {
    console.log(JSON.stringify(l, null, 2));
  }

  // Check if there are any messages or conversations from Slack
  // Look for any tables that might have Voltaire data
  const tables = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  console.log('\n=== Tables ===');
  for (const t of tables) {
    console.log(`  ${(t as any).table_name}`);
  }

  // Check conversation_messages for any Slack channels
  const { conversationMessages } = await import('../src/db/schema.js');
  const recentMsgs = await db.execute(sql`
    SELECT DISTINCT channel_id, org_id, COUNT(*) as cnt
    FROM conversation_messages
    GROUP BY channel_id, org_id
    ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log('\n=== Channels with messages ===');
  for (const m of recentMsgs) {
    const row = m as any;
    console.log(`  channel: ${row.channel_id} | org: ${row.org_id} | msgs: ${row.cnt}`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
