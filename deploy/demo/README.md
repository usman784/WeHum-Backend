# Demo / staging server (one VPS)

Everything on one machine with Docker: Postgres, Redis, MinIO, API, worker, scheduler, and Caddy (HTTPS by Let's
Encrypt, CMS files, API proxy). Code and data live in `/opt/wehum` on the server.

```
SSHPASS='<root password>' deploy/demo/deploy.sh srv988858.hstgr.cloud
```
Run it again to update (code and CMS are copied again; `.env` and data stay). Demo data (`seed-demo`) is added once.

- CMS: `https://<host>`; API on the same host (`/v1`, `/socket.io`, `/webhooks`); storage `https://<host>:9443`.
- Sign in: `raphael@wehum.app` + the password in `/opt/wehum/owner-password.txt` (first run prints it). Team accounts
  `admin@`, `editor@`, `moderator@wehum.app` have the same password. Each account sets up two-step sign-in on first login.
- Secrets: `/opt/wehum/.env` (generated on the server, never committed).
- Logs: `cd /opt/wehum && docker compose logs -f api` (emails are printed here: no mail server yet).
- Own domain later: set `SITE_HOST`, `PUBLIC_API_URL`, `CMS_ORIGINS`, `ADMIN_APP_URL`, `S3_PUBLIC_ENDPOINT`, `CDN_BASE_URL` in `.env`,
  point DNS at the server, run `deploy.sh <new host>` (the CMS is built for the new address). Fix the `wh_csrf` cookie `Domain` first
  if the CMS and API move to different subdomains.
