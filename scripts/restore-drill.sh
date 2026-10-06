#!/usr/bin/env bash
# Restore drill (P10, monthly): restore the newest dump into a throw-away database and check it is usable.
#   ADMIN_DATABASE_URL=postgresql://user:pw@host:5432/postgres BACKUP_BUCKET=s3://wehum-backups/prod scripts/restore-drill.sh
# Prints how long the restore took (RTO) and how old the newest data is (RPO). Writes nothing to production.
set -euo pipefail
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL (a server user that may CREATE DATABASE) is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
latest=$(aws s3 ls "${BACKUP_BUCKET}/" | awk '{print $4}' | grep '^wehum-.*\.dump$' | sort | tail -1)
[ -n "$latest" ] || { echo "no dump found in ${BACKUP_BUCKET}"; exit 1; }
db="wehum_restore_drill_$(date -u +%Y%m%d%H%M)"
work="/tmp/${latest}"
aws s3 cp "${BACKUP_BUCKET}/${latest}" "$work" --only-show-errors
target="${ADMIN_DATABASE_URL%/*}/${db}"
start=$(date +%s)
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${db}"
pg_restore --no-owner --no-privileges --exit-on-error --jobs=4 --dbname="$target" "$work"
took=$(( $(date +%s) - start ))
echo "restored ${latest} into ${db} in ${took}s"
# the checks a real recovery would need: schema version, people, content, the newest activity
psql "$target" -v ON_ERROR_STOP=1 -At -c "SELECT 'migrations: ' || count(*) FROM drizzle.__drizzle_migrations" \
  -c "SELECT 'users: ' || count(*) FROM users" \
  -c "SELECT 'live sessions: ' || count(*) FROM sessions WHERE status='live'" \
  -c "SELECT 'newest meditation: ' || coalesce(max(started_at)::text, 'none') FROM meditations" \
  -c "SELECT 'data age (RPO): ' || coalesce((now() - max(created_at))::text, 'n/a') FROM outbox_events"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE ${db} WITH (FORCE)"
rm -f "$work"
echo "drill ok — record the date, ${took}s and the RPO in ops/runbooks/restore.md"
