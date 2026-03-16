async function main() {
  await import('dotenv/config');
  const { db } = await import('../src/db/index.js');
  const { sql } = await import('drizzle-orm');

  // All distinct org IDs across tables
  console.log('=== Distinct org IDs in pending_actions ===');
  const paOrgs = await db.execute(sql`
    SELECT DISTINCT org_id, COUNT(*) as cnt, MIN(created_at) as first, MAX(created_at) as last
    FROM pending_actions
    GROUP BY org_id
    ORDER BY last DESC
  `);
  for (const r of paOrgs) {
    const row = r as any;
    console.log(`  org: ${row.org_id} | ${row.cnt} actions | first: ${row.first} | last: ${row.last}`);
  }

  console.log('\n=== Distinct org IDs in workspace_links ===');
  const wlOrgs = await db.execute(sql`SELECT * FROM workspace_links ORDER BY activated_at DESC`);
  for (const r of wlOrgs) {
    const row = r as any;
    console.log(`  org: ${row.org_id} | platform: ${row.platform} | workspace: ${row.workspace_id} | internal_ch: ${row.internal_channel_id} | activated: ${row.activated_at}`);
  }

  console.log('\n=== Distinct org IDs in conversation_history ===');
  const chOrgs = await db.execute(sql`
    SELECT DISTINCT org_id, COUNT(*) as cnt, MAX(created_at) as last
    FROM conversation_history
    GROUP BY org_id
    ORDER BY last DESC
  `);
  for (const r of chOrgs) {
    const row = r as any;
    console.log(`  org: ${row.org_id} | ${row.cnt} messages | last: ${row.last}`);
  }

  console.log('\n=== Distinct org IDs in activity_log ===');
  const alOrgs = await db.execute(sql`
    SELECT DISTINCT org_id, COUNT(*) as cnt, MAX(created_at) as last
    FROM activity_log
    GROUP BY org_id
    ORDER BY last DESC
  `);
  for (const r of alOrgs) {
    const row = r as any;
    console.log(`  org: ${row.org_id} | ${row.cnt} entries | last: ${row.last}`);
  }

  console.log('\n=== Bot settings ===');
  const settings = await db.execute(sql`SELECT * FROM bot_settings`);
  for (const r of settings) {
    console.log(`  ${JSON.stringify(r)}`);
  }
}
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
