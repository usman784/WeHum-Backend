# 5xx errors, API down, sockets dropped

**Means:** more than 1 % of requests fail with 5xx, a pod is not scraped, or half the app sockets went away.

**Confirm:** Sentry (new issue or spike?), `GET /readyz` on each pod (db / redis flags), load balancer target health.

**Do:**
1. Started with a deploy → roll back ([deploy.md](deploy.md)) first, investigate after.
2. `/readyz` says `db: false` → [database.md](database.md). `redis: false` → Redis failover in progress? Sockets and rate limits need Redis; the API keeps serving reads from Postgres.
3. Sockets halved without 5xx: usually a load-balancer idle timeout or a pod restart; check pod restarts and the LB's WebSocket timeout (must be > 65 s).
4. Maintenance needed: Settings → App & releases → Maintenance mode (the app shows "back soon").

**Close:** error rate < 0.1 % for 15 min; Sentry issue resolved or linked to a fix.
