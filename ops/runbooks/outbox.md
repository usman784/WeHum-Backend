# Outbox lag

**Means:** events written with a change (`outbox_events`) are not being published to Redis within 5 s, so CMS screens
and apps miss live updates (data itself is safe).

**Confirm:** `SELECT count(*), min(created_at) FROM outbox_events WHERE published_at IS NULL;`

**Do:**
1. The relay runs in every API pod (LISTEN outbox + a poll). Restart one API pod; the relay drains on start.
2. Rows stuck with errors in logs ("outbox drain failed"): Redis publish failing → check Redis.
3. Very large backlog after an outage: it drains in batches of 500; let it run. Published rows older than 7 days are removed by the daily lifecycle job.

**Close:** lag < 1 s for 15 min.
