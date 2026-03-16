import { db } from './src/db/index.js';
import { pendingActions, conversationHistory } from './src/db/schema.js';
import { sql, not, like, and } from 'drizzle-orm';

async function main() {
  console.log('Migrating IDs to unified format (prefixing with discord:)...');

  // 1. Migrate pending_actions.channel_id
  await db.update(pendingActions)
    .set({ 
      channelId: sql`CONCAT('discord:', channel_id)` 
    })
    .where(
      and(
        sql`channel_id IS NOT NULL`,
        not(like(pendingActions.channelId, 'discord:%')),
        not(like(pendingActions.channelId, 'slack:%'))
      )
    );
  console.log('Migrated channelIds in pending_actions');

  // 2. Migrate conversation_history.channel_id
  await db.update(conversationHistory)
    .set({ 
      channelId: sql`CONCAT('discord:', channel_id)` 
    })
    .where(
      and(
        not(like(conversationHistory.channelId, 'discord:%')),
        not(like(conversationHistory.channelId, 'slack:%'))
      )
    );
  console.log('Migrated channelIds in conversation_history');

  console.log('Migration complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
