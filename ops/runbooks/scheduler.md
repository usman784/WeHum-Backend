# Scheduler: presence lag, no leader, no group start

**Means:** the scheduler leader (APP_ROLE=scheduler) is not ticking: live numbers stop, the lobby does not update, and
the daily group start may be missed.

**Confirm:** `presence_tick_timestamp_seconds{role="scheduler"}` age; scheduler pod logs ("leader" lines); Redis reachable.

**Do:**
1. Restart the scheduler deployment. A follower takes over within one lease (~15 s); two replicas are normal.
2. If ticks run but `presence_tick_lag_ms` is high: Redis is slow or presence keys are huge (load). Check Redis CPU; scale per spec §6.5.
3. Group start missed (no `group:start` at T0): the app falls back to solo after the lobby countdown. If within 10 min of T0,
   run `group.start` for today by hand: add a job `{ date, startsAt }` named `group.start` to the `cron` queue (Bull board or a one-off script).

**Close:** ticks every 5 s for 15 min; group start emitted at the next T0.
