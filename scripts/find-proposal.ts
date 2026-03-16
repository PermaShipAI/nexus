async function main() {
  await import('dotenv/config');
  const { db } = await import('../src/db/index.js');
  const { sql } = await import('drizzle-orm');
  const { parseArgs } = await import('../src/utils/parse-args.js');

  // Search for merge rate specifically, also try "negative" 
  for (const term of ['merge rate', 'negative sentiment', 'merge.*rate']) {
    const rows = await db.execute(sql`
      SELECT id, org_id, agent_id, status, args, suggestion_id, created_at
      FROM pending_actions
      WHERE command = 'create-ticket'
        AND args::text ~* ${term}
      ORDER BY created_at DESC
      LIMIT 5
    `);
    if (rows.length > 0) {
      console.log(`\n=== "${term}" (${rows.length}) ===`);
      for (const r of rows) {
        const row = r as any;
        const args = parseArgs(row.args);
        console.log(`  [${row.created_at}] ${row.status} | ${row.agent_id} | "${args.title}" | suggestion: ${row.suggestion_id || 'none'}`);
      }
    } else {
      console.log(`\n=== "${term}" — no matches ===`);
    }
  }

  // Also show the most recently created proposals to see what's been coming in
  console.log('\n=== Most recent 15 proposals ===');
  const recent = await db.execute(sql`
    SELECT id, org_id, agent_id, status, args, suggestion_id, created_at
    FROM pending_actions
    WHERE command = 'create-ticket'
    ORDER BY created_at DESC
    LIMIT 15
  `);
  for (const r of recent) {
    const row = r as any;
    const args = parseArgs(row.args);
    console.log(`  [${row.created_at}] ${row.status} | ${row.agent_id} | "${args.title}" | suggestion: ${row.suggestion_id || 'none'}`);
  }
}
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
