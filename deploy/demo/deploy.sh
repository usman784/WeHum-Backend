#!/usr/bin/env bash
# Deploy (or update) the WeHum demo server from this Mac:
#   SSHPASS='<root password>' deploy/demo/deploy.sh srv988858.hstgr.cloud
# Builds the CMS for https://<host>, copies backend source + CMS build to /opt/wehum, then on the server:
# Docker (installed if missing) → .env with fresh secrets (first run only) → build → migrate → seed + demo data → up.
set -euo pipefail
HOST="${1:?usage: deploy.sh <host>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"   # the "WeHum Home" folder (backend/ and cms/ side by side)
: "${SSHPASS:?set SSHPASS to the root password}"
export SSHPASS
SSH=(sshpass -e ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no "root@$HOST")
RSYNC_SSH="sshpass -e ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no"

echo "▶ building the CMS for https://$HOST"
(cd "$ROOT/cms" && VITE_ENV=staging VITE_API_URL="https://$HOST" VITE_SOCKET_URL="https://$HOST" VITE_MOCKS= npx --yes pnpm@9 build >/dev/null)

echo "▶ copying to the server"
"${SSH[@]}" "mkdir -p /opt/wehum/backend /opt/wehum/cms"
rsync -az --delete -e "$RSYNC_SSH" --exclude node_modules --exclude dist --exclude .env --exclude test-results --exclude .git \
  "$ROOT/backend/" "root@$HOST:/opt/wehum/backend/"
rsync -az --delete -e "$RSYNC_SSH" "$ROOT/cms/dist/" "root@$HOST:/opt/wehum/cms/"
rsync -az -e "$RSYNC_SSH" "$HERE/docker-compose.yml" "$HERE/Caddyfile" "$HERE/env.template" "root@$HOST:/opt/wehum/"

echo "▶ server setup, build and start"
"${SSH[@]}" "HOST='$HOST' bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/wehum
if ! command -v docker >/dev/null; then
  echo "  installing Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 9443/tcp >/dev/null
fi
rnd() { openssl rand -hex "$1"; }
if [ ! -f .env ]; then
  echo "  creating .env with new secrets"
  OWNER_PW="Wehum-$(rnd 6)"
  sed -e "s/__SITE_HOST__/$HOST/g" -e "s/__PG_PASSWORD__/$(rnd 16)/g" -e "s/__S3_SECRET__/$(rnd 20)/g" \
      -e "s/__CDN_SECRET__/$(rnd 24)/g" -e "s/__METRICS_TOKEN__/$(rnd 24)/g" -e "s/__OWNER_PASSWORD__/$OWNER_PW/g" env.template > .env
  chmod 600 .env
  echo "$OWNER_PW" > owner-password.txt && chmod 600 owner-password.txt
fi
docker compose build --quiet api
# JWT signing keys + TOTP key, once (from the image's own jose)
if ! grep -q '^JWT_PRIVATE_KEY_B64=.' .env; then
  docker compose run --rm --no-deps -T api node -e "
    const { generateKeyPair, exportPKCS8, exportSPKI } = require('jose'); const c = require('node:crypto');
    (async () => { const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }); const kid = 'k' + Date.now().toString(36);
      console.log('JWT_PRIVATE_KEY_B64=' + Buffer.from(await exportPKCS8(privateKey)).toString('base64'));
      console.log('JWT_PUBLIC_KEYS_B64=' + Buffer.from(JSON.stringify([{ kid, pem: await exportSPKI(publicKey) }])).toString('base64'));
      console.log('JWT_KID=' + kid); console.log('TOTP_ENC_KEY_BASE64=' + c.randomBytes(32).toString('base64')); })();" >> .env
fi
docker compose up -d postgres redis minio
docker compose run --rm -T api node dist/db/migrate.js
docker compose run --rm -T api node dist/db/seed.js
docker compose run --rm -T api node dist/db/seed-demo.js
docker compose up -d
sleep 5
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo "  owner: raphael@wehum.app / $(cat owner-password.txt 2>/dev/null || echo '(see /opt/wehum/owner-password.txt)')"
REMOTE
echo "✔ https://$HOST"
