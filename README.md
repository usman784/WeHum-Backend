# WeHum Backend

## Versions

The backend has no store release of its own. Its tags follow the app: `v<name>+<build>` marks the last backend commit made on or before that app release day, and says which backend that app build was used with. If you need data or behaviour from an older build, check out that tag. Migrations in `drizzle/` only move forward, so rolling back code to a tag may need the later migrations to be compatible; check before deploying an old tag. `package.json` stays `0.1.0`; the tags are the version.

### Unreleased (after 1.0.2+5)
- Nothing yet.

### 1.0.2+5 (29 Oct 2026) · tag `v1.0.2+5`
- Online now: who has the app open (Redis presence), feeding the CMS dots, the Online now tab and the Dashboard map.
- No progress or metrics for guests.
- Edit profile: accounts only, phone photos upload, one username per account (migration `0011_username_backfill.sql`).

### 1.0.1+4 (27 Oct 2026) · tag `v1.0.1+4`
- Silence Room by country: `silence:live`, `GET /v1/silence`, and `dashboard:kpis` carry where people meditate.
- Group meditation every few hours and a separate weekly Global meditation.
- Dedications at any time (`POST /v1/dedications` accepts `sessionId`); every new dedication is announced to the CMS (`moderation:new`).
- Meditation of the Day plays the latest earlier audio when today's is not scheduled.

### 1.0.1+3 (15 Oct 2026) · tag `v1.0.1+3`
- Stitch endpoints: forgiving streaks, 30 s previews, Silence Room, hourly sits and intentions, world gauge, crisis directory.
- Usernames, names, avatar, social profile, branding config, push cap and delivery tracking, scheduled daily messages.
- Inbox delete, one e-mail one account, Mailchimp sync, YouTube resolve with warnings (made-for-kids refused).
- CD: deploys the demo server from GitHub Actions after CI is green.

### 1.0.0+2 (9 Oct 2026) · tag `v1.0.0+2`
- Phases P0 to P11: auth (guest, Apple, Google, email, merge, refresh rotation), catalog, Today and stats, Socket.IO realtime, subscriptions (RevenueCat), community and moderation, push and inbox, analytics, hardening, challenges behind flags.
- Bootstrap carries `latestVersion` and `storeUrls` for the in-app update prompt; live aggregate carries `todayTop`.

Node.js 22 · NestJS (Fastify) · PostgreSQL 16 (Drizzle ORM) · Redis 7 · Socket.IO · BullMQ.
Full spec: [`WeHum_Backend_Spec.md`](WeHum_Backend_Spec.md). API contract: [`openapi/openapi.yaml`](openapi/openapi.yaml) · live docs at `/docs`.

## Run locally (VS Code terminal)
```bash
npm install
docker compose up -d          # Postgres 16, Redis 7, MinIO (S3), Mailpit (emails → http://localhost:8025)
npm run keys                  # creates .env (from .env.example) + JWT/TOTP keys
npm run db:migrate            # applies drizzle/*.sql
npm run seed                  # config, founding offer, CMS owner, demo catalog
npm run dev                   # http://localhost:3000  ·  Swagger: http://localhost:3000/docs
```
No Docker? Install PostgreSQL 16 + Redis locally and set `DATABASE_URL` / `REDIS_URL` in `.env`.

| Command | What |
|---|---|
| `npm test` | unit + e2e. Needs DB `wehum_test` (`docker compose exec postgres createdb -U wehum wehum_test`), Redis, and MinIO with bucket `wehum-test` (compose creates it). If a port is taken: `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_S3_ENDPOINT` |
| `npm run db:generate` | new SQL migration after editing `src/db/schema.ts` |
| `npm run db:studio` | browse the DB |
| `npm run dev:worker` / `dev:scheduler` | background jobs / schedules (from P4) |

CMS first login: `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD` from `.env` (2-step setup on first sign-in).

## Layout
```
src/
  config/env.ts        env validation (fails fast)
  db/schema.ts         PostgreSQL schema (authoritative) · migrate.ts · seed.ts
  infra/               Postgres pool + Drizzle, Redis (keys in redis.ts)
  common/              errors, envelope, zod pipe, pagination
  modules/             feature modules (auth, me, catalog, today, …) — added per phase
  realtime/            Socket.IO contract + gateways
drizzle/               SQL migrations
test/                  e2e tests (real Postgres + Redis)
```

## Oct 12 — Stitch redesign
Migration `0007_stitch` and the new endpoints are described in `WeHum_Backend_Spec.md` §4.5, §5.6, §7.6 and §14b. Build map: `../stitch-export/SCREEN_MAP.md`.
