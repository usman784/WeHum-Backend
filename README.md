# WeHum Backend

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
| `npm test` | unit + e2e (needs DB `wehum_test`: `createdb -U wehum wehum_test`) |
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
