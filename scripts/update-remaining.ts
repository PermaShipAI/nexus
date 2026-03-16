async function main() {
  await import('dotenv/config');
  const { db } = await import('../src/db/index.js');
  const { pendingActions } = await import('../src/db/schema.js');
  const { eq } = await import('drizzle-orm');

  const updates = [
    { id: 'db8b0f5a-e5f9-45ff-8434-c165b88e9094', suggestionId: '94e64684-44bb-425e-8975-82e33b98a6d2' },
    { id: '0af492cd-67cb-43cf-a87c-6ef0c8568e0e', suggestionId: '99e828fb-b53b-44e4-9505-2c510398e1f3' },
  ];

  for (const u of updates) {
    await db.update(pendingActions).set({ suggestionId: u.suggestionId }).where(eq(pendingActions.id, u.id));
    console.log(`Updated ${u.id} → ${u.suggestionId}`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
