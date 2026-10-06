# WeHum runbooks

One page per alert (the alert's `runbook` annotation links here). Each page: what it means, how to confirm, what to do,
how to close it. Keep them short; add what you learned after every incident.

| Page | Alerts |
|---|---|
| [latency.md](latency.md) | ApiLatencyOverBudget, ApiLatencyOverBudgetGeneral |
| [errors.md](errors.md) | Api5xxRate, ApiDown, SocketsDropped |
| [scheduler.md](scheduler.md) | PresenceLag, SchedulerLeaderMissing, GroupStartNotEmitted |
| [outbox.md](outbox.md) | OutboxLag |
| [queues.md](queues.md) | QueueBacklog, JobsFailing |
| [revenuecat.md](revenuecat.md) | RevenueCatWebhooksRejected, RevenueCatWebhooksSilent |
| [push.md](push.md) | PushFailing |
| [attestation.md](attestation.md) | AttestationRejecting |
| [database.md](database.md) | DbPoolExhausted, DbCpuHigh, RedisMemoryHigh |
| [restore.md](restore.md) | BackupMissing, and the monthly restore drill |
| [deploy.md](deploy.md) | Deploy and roll back |

Common tools: Grafana "WeHum API" dashboard, Sentry (release = git sha), `GET /readyz` on each pod, logs by `x-request-id`.
