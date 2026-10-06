# Backups and the restore drill

**Backups:** managed Postgres point-in-time recovery (7 days) **plus** a nightly `scripts/backup.sh` (pg_dump → S3,
35 days). The script reports to the Pushgateway; `BackupMissing` fires after 30 h without one.

**Restore drill (monthly, P10 exit criterion):**
```
ADMIN_DATABASE_URL=postgresql://admin:…@db:5432/postgres BACKUP_BUCKET=s3://wehum-backups/prod scripts/restore-drill.sh
```
It restores the newest dump into a throw-away database, checks migrations, users, live sessions and the newest data, prints the
restore time (RTO) and data age (RPO), and drops the database. Record each run below.

**Real recovery:**
1. Prefer point-in-time recovery to a new instance (minutes of data loss at most).
2. Otherwise restore the newest dump with `pg_restore --no-owner --jobs=4` into a new instance.
3. Point `DATABASE_URL` at it, run `npm run db:migrate` (no-op if current), roll the deployments, check `/readyz`.
4. Redis holds no data that cannot be rebuilt (presence, caches, counters are rebuilt by the rollup).

| Date | Dump | Restore time | Data age | By |
|---|---|---|---|---|
| — | first drill is due with the first staging data | | | |
