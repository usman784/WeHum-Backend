import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import * as schema from './schema';

export type DB = NodePgDatabase<typeof schema>;

export function createPool(url = env.DATABASE_URL) {
  return new Pool({
    connectionString: url,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: env.APP_ROLE === 'api' ? 5_000 : 60_000,
    application_name: `wehum-${env.APP_ROLE}`,
  });
}

export function createDb(pool: Pool): DB {
  return drizzle(pool, { schema, casing: 'snake_case' });
}

export { schema };
