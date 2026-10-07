# Demo / staging server (one VPS)

Everything on one machine with Docker: Postgres, Redis, MinIO, API, worker, scheduler, and Caddy (HTTPS by Let's
Encrypt, CMS files, API proxy). Code and data live in `/opt/wehum` on the server.

```
SSHPASS='<root password>' deploy/demo/deploy.sh 147.93.59.172 cms.wehum.app api.wehum.app .wehum.app
```
Run it again to update (code and CMS are copied again; `.env` and data stay). Demo data (`seed-demo`) is added once.

- CMS: `https://cms.wehum.app`; API `https://api.wehum.app` (`/v1`, `/socket.io`, `/webhooks`, also for the app); storage `https://api.wehum.app:9443`.
- DNS (Namecheap → Advanced DNS): A records `cms` and `api` → the server IP. Caddy gets the certificates by itself.
- The CMS reads the CSRF cookie set by the API across subdomains: `ADMIN_COOKIE_DOMAIN=.wehum.app`.
- Sign in: `raphael@wehum.app` + the password in `/opt/wehum/owner-password.txt` (first run prints it). Team accounts
  `admin@`, `editor@`, `moderator@wehum.app` have the same password. Each account sets up two-step sign-in on first login.
- Secrets: `/opt/wehum/.env` (generated on the server, never committed).
- Logs: `cd /opt/wehum && docker compose logs -f api` (emails are printed here: no mail server yet).
- Other hosts: run `deploy.sh` with the new names after creating `.env` again (or edit `CMS_HOST`, `API_HOST`, `ADMIN_COOKIE_DOMAIN`, `PUBLIC_API_URL`, `CMS_ORIGINS`, `ADMIN_APP_URL`, `S3_PUBLIC_ENDPOINT`, `CDN_BASE_URL` in `/opt/wehum/.env`).
