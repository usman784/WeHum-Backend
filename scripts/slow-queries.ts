/**
 * Weekly slow-query review (spec §11): the statements with the most total time, from pg_stat_statements.
 *   DATABASE_URL=... npx tsx scripts/slow-queries.ts [limit]
 * Needs `shared_preload_libraries=pg_stat_statements` (docker-compose.yml and the managed DB parameter group).
 */
import 'dotenv/config';
import { Client } from 'pg';

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  await db.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  const limit = Number(process.argv[2] ?? 20);
  const { rows } = await db.query<{ calls: string; total_ms: number; mean_ms: number; p_rows: string; query: string }>(`
    SELECT calls, round(total_exec_time)::float8 AS total_ms, round(mean_exec_time::numeric, 2)::float8 AS mean_ms, rows AS p_rows,
           regexp_replace(query, '\\s+', ' ', 'g') AS query
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    ORDER BY total_exec_time DESC LIMIT $1`, [limit]);
  for (const r of rows) console.log(`${String(r.mean_ms).padStart(9)} ms avg  ${String(r.calls).padStart(9)} calls  ${String(r.total_ms).padStart(10)} ms total  ${r.query.slice(0, 160)}`);
  const slow = rows.filter((r) => r.mean_ms > 50);
  console.log(slow.length ? `\n${slow.length} statement(s) average over 50 ms: EXPLAIN (ANALYZE, BUFFERS) them.` : '\nNothing averages over 50 ms.');
  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
