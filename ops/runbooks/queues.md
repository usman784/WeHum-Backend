# Queue backlog or failing jobs

**Means:** a BullMQ queue (`media`, `stats`, `cron`) has > 5,000 waiting jobs, or jobs keep failing.

**Confirm:** `bullmq_queue_depth` by queue; worker logs ("failed"); Sentry job errors.

**Do:**
1. `stats` backlog after a burst: scale the worker deployment; stats are idempotent per meditation.
2. `media` failing: ffmpeg errors in logs → a bad upload (the CMS shows "processing failed"); infrastructure errors → S3 credentials or disk.
3. `cron` failing on `rc.process`: see [revenuecat.md](revenuecat.md); on `push.minute`: see [push.md](push.md).
4. Never delete the queue; failed jobs are kept 5,000 deep for inspection and retry.

**Close:** depth back near 0 and no new failures for 30 min.
