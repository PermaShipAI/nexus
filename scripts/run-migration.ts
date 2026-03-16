import 'dotenv/config';
import postgres from 'postgres';

async function main() {
  const sql = postgres(process.env.DATABASE_URL as string);
  await sql.unsafe(`ALTER TABLE "workspace_links" ADD COLUMN IF NOT EXISTS "org_name" text`);
  console.log('Migration applied: org_name column added to workspace_links');
  await sql.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
