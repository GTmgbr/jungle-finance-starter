import { createDataSource } from './data-source';

async function main(): Promise<void> {
  const db = createDataSource();
  await db.initialize();
  try {
    const migrations = await db.runMigrations();
    console.log(JSON.stringify({ event: 'migrations_applied', count: migrations.length }));
  } finally {
    await db.destroy();
  }
}
main().catch((err: unknown) => { console.error(err); process.exitCode = 1; });
