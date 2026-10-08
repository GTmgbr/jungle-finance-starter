import { createDataSource } from './data-source';

async function main(): Promise<void> {
  const db = createDataSource();
  await db.initialize();
  try { await db.undoLastMigration(); }
  finally { await db.destroy(); }
}
main().catch((err: unknown) => { console.error(err); process.exitCode = 1; });
