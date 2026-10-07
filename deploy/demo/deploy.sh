#!/usr/bin/env bash
# Deploy (or update) the WeHum demo server from this Mac:
#   SSHPASS='<root password>' deploy/demo/deploy.sh <server> <cms host> <api host> <cookie domain>
#   SSHPASS='…' deploy/demo/deploy.sh 147.93.59.172 cms.wehum.app api.wehum.app .wehum.app
# Builds the CMS for https://<api host>, copies backend source + CMS build to /opt/wehum, then on the server:
# Docker (installed if missing) → .env with fresh secrets (first run only) → build → migrate → seed + demo data → up.
set -euo pipefail
HOST="${1:?usage: deploy.sh <server> <cms host> <api host> <cookie domain>}"
CMS_HOST="${2:?cms host, e.g. cms.wehum.app}"
API_HOST="${3:?api host, e.g. api.wehum.app}"
COOKIE_DOMAIN="${4:?cookie domain, e.g. .wehum.app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"   # the "WeHum Home" folder (backend/ and cms/ side by side)
: "${SSHPASS:?set SSHPASS to the root password}"
export SSHPASS
SSH=(sshpass -e ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no "root@$HOST")
RSYNC_SSH="sshpass -e ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no"

echo "▶ building the CMS for https://$API_HOST"
(cd "$ROOT/cms" && VITE_ENV=staging VITE_API_URL="https://$API_HOST" VITE_SOCKET_URL="https://$API_HOST" VITE_MOCKS= npx --yes pnpm@9 build >/dev/null)

echo "▶ copying to the server"
"${SSH[@]}" "mkdir -p /opt/wehum/backend /opt/wehum/cms"
rsync -az --delete -e "$RSYNC_SSH" --exclude node_modules --exclude dist --exclude .env --exclude test-results --exclude .git \
  "$ROOT/backend/" "root@$HOST:/opt/wehum/backend/"
rsync -az --delete -e "$RSYNC_SSH" "$ROOT/cms/dist/" "root@$HOST:/opt/wehum/cms/"
rsync -az -e "$RSYNC_SSH" "$HERE/docker-compose.yml" "$HERE/env.template" "$HERE/remote.sh" "$HERE/nginx" "$HERE/img" "root@$HOST:/opt/wehum/"

echo "▶ server setup, build and start"
"${SSH[@]}" "CMS_HOST='$CMS_HOST' API_HOST='$API_HOST' COOKIE_DOMAIN='$COOKIE_DOMAIN' bash /opt/wehum/remote.sh"
echo "✔ CMS https://$CMS_HOST   API https://$API_HOST"
