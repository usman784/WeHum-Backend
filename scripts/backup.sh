#!/usr/bin/env bash
# Nightly logical backup (P10): pg_dump (custom format) → gzip-free .dump → S3 with server-side encryption.
#   DATABASE_URL=... BACKUP_BUCKET=s3://wehum-backups/prod scripts/backup.sh
# Keep 35 daily dumps (bucket lifecycle rule). Managed Postgres point-in-time recovery stays on as the first line;
# this dump is the independent copy the restore drill uses.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required, e.g. s3://wehum-backups/prod}"
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
file="/tmp/wehum-${stamp}.dump"
pg_dump --format=custom --no-owner --no-privileges --compress=6 --file="$file" "$DATABASE_URL"
size=$(wc -c <"$file")
aws s3 cp "$file" "${BACKUP_BUCKET}/wehum-${stamp}.dump" --sse AES256 --only-show-errors
rm -f "$file"
echo "backup ok: ${BACKUP_BUCKET}/wehum-${stamp}.dump (${size} bytes)"
# for the BackupMissing alert (ops/alerts): report success to the Prometheus Pushgateway when one is set
if [ -n "${PUSHGATEWAY_URL:-}" ]; then
  printf 'wehum_backup_last_success_timestamp_seconds %s\nwehum_backup_size_bytes %s\n' "$(date +%s)" "$size" |
    curl -fsS --data-binary @- "${PUSHGATEWAY_URL}/metrics/job/wehum_backup" >/dev/null
fi
