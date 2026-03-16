async function main() {
  await import('dotenv/config');
  const { db } = await import('../src/db/index.js');
  const { sql } = await import('drizzle-orm');

  // Check activity_log columns
  const cols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'activity_log'
    ORDER BY ordinal_position
  `);
  console.log('activity_log columns:', cols.map((c: any) => c.column_name).join(', '));

  const activity = await db.execute(sql`
    SELECT * FROM activity_log
    ORDER BY created_at DESC
    LIMIT 20
  `);
  console.log('\n=== Recent Activity ===');
  for (const a of activity) {
    console.log(JSON.stringify(a));
  }
}
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
