import { db } from '../db/index.js';
import { pendingActions } from '../db/schema.js';
import { eq, like, and } from 'drizzle-orm';

async function main() {
  const actions = await db.select().from(pendingActions).where(
    and(
      eq(pendingActions.status, 'pending'),
      like(pendingActions.description, '%Data loss in action-history%')
    )
  );
  console.log(JSON.stringify(actions, null, 2));
  process.exit(0);
}
main().catch(console.error);
