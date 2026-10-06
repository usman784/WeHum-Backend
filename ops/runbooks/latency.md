# API latency over budget

**Means:** p95 of a route is over its budget for 5 min (launch routes 80 ms, others 200 ms; spec §6.3).

**Confirm:** Grafana → API latency by route. Is it one route or all? Compare with `db_pool_in_use`, DB CPU, Redis latency.

**Do:**
1. One route: check Sentry performance for that transaction; run `npm run db:slow` against the replica and `EXPLAIN (ANALYZE, BUFFERS)` the top statement. Missing index → migration.
2. All routes + pool full: see [database.md](database.md). All routes + CPU on pods: scale the API deployment (HPA max) and look for a hot loop in the newest release (roll back if it started with a deploy, [deploy.md](deploy.md)).
3. Launch routes only: check the cache hit ratio (`cache_lookups_total{result="hit"}` / all). A config write storm drops the caches; it recovers by itself.

**Close:** p95 under budget for 15 min; note the cause here.
