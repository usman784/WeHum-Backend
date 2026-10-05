import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, createPool } from './client';

/** Applies ./drizzle/*.sql in order (idempotent). Used locally and in CD before rollout. */
export async function runMigrations(url?: string) {
  const pool = createPool(url);
  try {
    await migrate(createDb(pool), { migrationsFolder: './drizzle' });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations().then(() => { console.log('migrations applied'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
}
