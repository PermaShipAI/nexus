async function main() {
  await import('dotenv/config');
  const { db } = await import('../src/db/index.js');
  const { sql } = await import('drizzle-orm');

  const rows = await db.execute(sql`
    SELECT DISTINCT channel_id, org_id, COUNT(*) as cnt,
           MAX(created_at) as last_msg
    FROM conversation_history
    GROUP BY channel_id, org_id
    ORDER BY last_msg DESC
    LIMIT 20
  `);
  console.log('=== Channels with conversation history ===');
  for (const r of rows) {
    const row = r as any;
    console.log('  ch: ' + row.channel_id + ' | org: ' + row.org_id + ' | msgs: ' + row.cnt + ' | last: ' + row.last_msg);
  }

  const activity = await db.execute(sql`
    SELECT type, agent_id, org_id, channel_id, created_at
    FROM activity_log
    ORDER BY created_at DESC
    LIMIT 20
  `);
  console.log('\n=== Recent Activity ===');
  for (const a of activity) {
    const row = a as any;
    console.log('  [' + row.created_at + '] ' + (row.org_id || '').substring(0,8) + ' | ' + row.agent_id + ' | ' + row.type + ' | ch:' + row.channel_id);
  }
}
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
