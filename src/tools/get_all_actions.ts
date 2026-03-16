import { db } from '../db/index.js';
import { pendingActions } from '../db/schema.js';

async function main() {
  const actions = await db.select().from(pendingActions);
  console.log(actions.map(a => `${a.id} [${a.status}] ${a.agentId} - ${a.description}`));
  process.exit(0);
}
main().catch(console.error);
