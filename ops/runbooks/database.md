# Database and Redis pressure

**Means:** the Postgres pool is nearly full, DB CPU > 80 %, or Redis memory > 80 % (Redis runs `noeviction`: at 100 % writes fail).

**Do (Postgres):**
1. `npm run db:slow` (pg_stat_statements) → the top statement by total time; `EXPLAIN (ANALYZE, BUFFERS)`; add the index in a migration.
2. Long-running queries: `SELECT pid, now() - query_start, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY 2 DESC;` — cancel analytics queries first.
3. Pool full but DB idle: a leak or a slow external call holding a transaction; check the newest release.
4. Scale path (spec §6.5): read replica for analytics/admin lists, larger instance.

**Do (Redis):**
1. `INFO memory`, `--bigkeys`. Presence and lobby keys expire; rate-limit keys expire; a growing key without TTL is a bug.
2. Scale the node (memory) — do not switch the eviction policy: evicting sessions or presence silently breaks features.

**Close:** below threshold for 30 min; record the cause.
