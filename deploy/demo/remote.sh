#!/usr/bin/env bash
# Runs ON the server (copied by deploy.sh): Docker, .env, build, migrate, seed, start, nginx + certbot.
# Needs CMS_HOST, API_HOST, COOKIE_DOMAIN. Every `docker compose run` reads /dev/null: never this script.
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
  sed -e "s/__CMS_HOST__/$CMS_HOST/g" -e "s/__API_HOST__/$API_HOST/g" -e "s/__COOKIE_DOMAIN__/$COOKIE_DOMAIN/g" -e "s/__PG_PASSWORD__/$(rnd 16)/g" -e "s/__S3_SECRET__/$(rnd 20)/g" \
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
      console.log('JWT_KID=' + kid); console.log('TOTP_ENC_KEY_BASE64=' + c.randomBytes(32).toString('base64')); })();" </dev/null >> .env
fi
docker compose up -d postgres redis minio
docker compose run --rm -T api node dist/db/migrate.js </dev/null
docker compose run --rm -T api node dist/db/seed.js </dev/null
docker compose run --rm -T api node dist/db/seed-demo.js </dev/null
# cover images the seed points at (img/<name>.jpg)
docker compose run --rm -T -v /opt/wehum/img:/img:ro api node dist/db/seed-images.js /img </dev/null
# placeholder audio for the seeded media rows, so players, downloads and Build your own work on the demo
docker compose run --rm -T api node dist/db/seed-media.js </dev/null
docker compose up -d

# ── host nginx (shared with other sites on this server: only the wehum-* files are written)
site() { sed -e "s/__CMS_HOST__/$CMS_HOST/g" -e "s/__API_HOST__/$API_HOST/g" "nginx/$1.conf" > "/etc/nginx/sites-available/$1"; ln -sf "/etc/nginx/sites-available/$1" "/etc/nginx/sites-enabled/$1"; }
if [ ! -d "/etc/letsencrypt/live/$CMS_HOST" ] || [ ! -d "/etc/letsencrypt/live/$API_HOST" ]; then
  site wehum-cms; site wehum-api
  nginx -t && systemctl reload nginx
  certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d "$CMS_HOST" -d "$API_HOST" --cert-name "$API_HOST" >/dev/null
  # certbot put both names on one certificate; give the CMS name its own path too, so the files below are simple
  [ -d "/etc/letsencrypt/live/$CMS_HOST" ] || ln -s "/etc/letsencrypt/live/$API_HOST" "/etc/letsencrypt/live/$CMS_HOST"
fi
site wehum-storage
nginx -t && systemctl reload nginx
sleep 5
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo "  owner: raphael@wehum.app / $(cat owner-password.txt 2>/dev/null || echo '(see /opt/wehum/owner-password.txt)')"
