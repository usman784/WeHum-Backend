# WeHum — Backend Build Spec (Node.js · TypeScript · NestJS · PostgreSQL · Redis · Socket.IO)

> Single source of truth for the WeHum backend that serves the **mobile app** (`../app/WeHum_App_Spec.md`) and the **admin CMS** (`../cms/WeHum_CMS_Spec.md`).
> **No Firebase database, auth or functions.** The only Google service used is **FCM HTTP v1 as push transport** (Android + iOS via APNs key); nothing else.
> Starter code for this folder: `backend/starter/` (Prisma schema, OpenAPI outline, NestJS skeleton, Docker). The **API contract** (§5, `starter/openapi/openapi.yaml`) and the **socket contract** (§7) are what the app and CMS build against. Change them here first.

---

## 0. How to use this file (instructions for the builder / AI agent)

1. Work **phase by phase** (§14). Never start a phase before the current one is green.
2. At the end of every phase:
   1. Run the phase's exit tests (§13 + the phase row).
   2. Fix every failure and re-run until green.
   3. Update **§16 Phase reports** in this file: what was built, the commands you ran with pass/fail counts, bugs found and fixed, decisions, open issues and evidence.
   4. Regenerate `openapi.yaml` (from `@nestjs/swagger`) and commit it. The app and CMS generate their clients from it.
3. Every endpoint must have:
   - zod validation;
   - an auth guard and role guard;
   - the standard envelope and error codes (§5.2);
   - an audit entry if it is an admin mutation;
   - a test.
4. Performance is a feature. Respect the budgets in §9. Any endpoint over budget is a bug.
5. Product rules (§1.2) come from the client and override convenience.

---

## 1. Product context

**WeHum** is a meditation app by Raphael Reiter. Core promise: *you never meditate alone*.

**Meditation of the Day (MOTD)**
- One MOTD per day, in three lengths (10, 30 or 45 min).
- Users can meditate right away, or wait for the **group meditation**: the MOTD started for everyone at one configured time (for example 16:00 UTC).

**Live presence**
- Live presence shows how many people are meditating and from which countries.
- It must be **real and live**. Numbers are never faked.

**Admin CMS**
- Manages all content.
- Shows everything **live**.

### 1.1 Users
| Type | How the backend sees it |
|---|---|
| Guest (free) | `users.is_guest = true`, identity `device` (install id), no entitlement |
| Guest (member) | Guest plus an active `entitlements` row (RevenueCat purchase made with no login; App Store 5.1.1) |
| Free with account | `is_guest = false`, Apple/Google/email identity |
| Member | `entitlements.active = true` (trial or paid) |
| Admin | Separate `admin_users` table, roles owner/admin/editor/moderator, mandatory 2FA |

### 1.2 Client rules the backend enforces
- **Wording.** All copy says "meditation", "meditate" or "meditating". Never "sit".
- **Progress, not streaks.** There are no streak, grace-day or rest-day fields anywhere. Progress = minutes, meditations and days this week.
- **No previews.** There are no 30-second preview URLs.
- **Silence Room, MOTD and dedications.**
  - The Silence Room, MOTD audio, daily messages, Build your own, SoS, downloads and the group meditation are **premium**.
  - Free users can **read** dedications.
  - Posting a dedication needs a **member with an account**, and only **after a finished meditation**. Limit: 3 per day. No links.
- **Free and premium items.**
  - Free items are "Free for you" items: Raphael's online library, YouTube-hosted. The word "YouTube" is never shown to users.
  - Premium items carry the `access = premium` flag.
- **Empty-room rule.** If live total < `emptyRoomThreshold` (default 10), the API returns `quiet: true` and the "meditated today" count instead of "meditating now".
- **Pricing.**
  - Products: `wehum_annual_founding` $59/yr (Founding 1,000 cap), `wehum_annual` $79/yr, `wehum_monthly` $9.99/mo, all with a 7-day trial.
  - Prices always come from RevenueCat or the stores. The backend never sends a price for display.
- **Coming soon (feature flags).** Challenges, Gratitude feed, Breathwork, Milestones, Intent.
- **Out of V1.** Profiles, friends, chat.

---

## 2. Tech stack

| Area | Choice | Why |
|---|---|---|
| Runtime | **Node.js 22 LTS**, TypeScript 5 (strict) | LTS, fast |
| Framework | **NestJS 11 with Fastify adapter** (`@nestjs/platform-fastify`) | Modules, DI, guards; Fastify is about 2× Express throughput |
| Validation | **zod** + `nestjs-zod` (DTOs → OpenAPI) | One schema for validation, types and docs |
| Database | **PostgreSQL 16** (managed: AWS RDS / Neon / Supabase-Postgres), extensions `citext`, `pg_trgm` | Relational, strong indexing, JSONB where flexible |
| ORM | **Prisma 6** (+ `$queryRaw` for heavy aggregates) | Typed client, migrations (`prisma migrate`) |
| Pooling | PgBouncer (transaction mode) or provider pooler; Prisma `connection_limit` per instance | Stable connections under load |
| Cache, pub/sub, presence, rate limit | **Redis 7** (AWS ElastiCache / Upstash / Redis Cloud) via `ioredis` | Sub-ms hot data |
| Realtime | **Socket.IO 4** (`@nestjs/websockets` + `@nestjs/platform-socket.io`) + `@socket.io/redis-adapter` | Rooms, acks, reconnection, horizontal scale |
| Jobs / schedules | **BullMQ** (Redis) — repeatable jobs + workers | Media processing, push fan-out, rollups |
| Auth | Own JWT (`jose`, **EdDSA/Ed25519**, `kid` rotation); refresh rotation; `argon2` (argon2id); `otplib` (TOTP); Apple and Google id-token verification via JWKS | No vendor lock-in |
| Storage / CDN | **S3-compatible** (AWS S3 or Cloudflare R2) + **CloudFront / Cloudflare CDN**, signed URLs | Media at the edge |
| Media processing | `ffmpeg`/`ffprobe` (loudness `ebur128`, AAC transcode, optional HLS), `sharp` + `blurhash` for images | §8.5 |
| Payments | RevenueCat webhooks + REST v2 | Store receipts never parsed by us |
| Push | `firebase-admin` **messaging only** (FCM HTTP v1) — or swap for APNs direct + FCM if desired | Transport only |
| Email | Postmark or AWS SES (`nodemailer` transport) | Magic links, resets, invites, exports |
| YouTube metadata | YouTube Data API v3 (`googleapis`) | Free items |
| Logs | **pino** (JSON) + `pino-http`, request id = `traceId` | Structured |
| Errors / traces | **Sentry** (`@sentry/node`, performance tracing) | Same tool in app and CMS |
| Metrics | `prom-client` → Prometheus/Grafana (or Datadog/CloudWatch) | §11 |
| API docs | `@nestjs/swagger` at `/docs` (staging only) + committed `openapi.yaml` | Clients are generated from it |
| Tests | Vitest + Supertest, Testcontainers (Postgres + Redis), `socket.io-client` for socket e2e, k6 for load | §13 |
| Packaging | Docker (distroless node), docker-compose for local | §12 |

Pin exact versions at project start and record them in §16.

---

## 3. Architecture

```
            ┌──────────── CloudFront/Cloudflare CDN ────────────┐
 Mobile app ──HTTPS──► /v1/* (catalog cached at edge)            │ media (signed URLs)
    │  └─WSS── /live  ─┐                                         │
 CMS (React) ─HTTPS──► /v1/admin/*                               │
    └──WSS── /admin ───┤                                         │
                       ▼                                         ▼
              ┌──────────────────┐   Redis pub/sub +    ┌──────────────┐
              │  api (N pods)    │◄─ socket.io adapter ─►│   Redis 7    │
              │ HTTP + Socket.IO │                      │ cache·presence│
              └──────┬───────────┘                      │ rate·BullMQ   │
                     │ Prisma (PgBouncer)               └──────┬───────┘
                     ▼                                         │
              ┌──────────────┐        ┌──────────────────┐     │
              │ PostgreSQL 16│◄──────►│ worker (M pods)  │◄────┘ BullMQ queues
              └──────────────┘        │ media·push·jobs  │
                                      └──────────────────┘
                                      ┌──────────────────┐
                                      │ scheduler (1 pod,│ repeatable jobs, leader lock
                                      │  leader-elected) │ presence tick, rollups, push minute
                                      └──────────────────┘
```

All three processes are built from **one codebase and one image**, selected by `APP_ROLE=api|worker|scheduler`.

**API process**
- Stateless.
- Horizontally scaled behind an ALB with WebSocket support.
- Sockets use `transports: ['websocket']`, so no sticky sessions are needed.

**Realtime events after commit.** Mutations write domain events to `outbox_events` in the same transaction. Then:
1. The outbox relay (in the API process, every 200 ms, plus `NOTIFY` wake-up) publishes them to Redis channel `events`.
2. Every API pod's gateway receives each event and emits it to the right Socket.IO rooms.

So no event is sent for a rolled-back write.

### 3.1 Folder structure
```
wehum-backend/
  src/
    main.ts                       # bootstrap by APP_ROLE
    app.module.ts
    config/                       # env schema (zod), config service
    common/
      envelope.interceptor.ts     # { data, meta }
      error.filter.ts             # { error: { code, message, details, traceId } }
      errors.ts                   # AppError + codes (§5.3)
      guards/ (jwt.guard, roles.guard, entitlement.guard, account.guard, app-version.guard)
      decorators/ (CurrentUser, Roles, Public, Premium, Idempotent, Audit)
      interceptors/ (audit.interceptor, etag.interceptor, timing.interceptor)
      pagination.ts               # cursor encode/decode (base64url of {k, id})
      zod.ts                      # nestjs-zod setup
    infra/
      prisma/ (prisma.service.ts, tx helper)
      redis/  (redis.module.ts: client, subscriber, keys.ts)
      cache/  (cache.service.ts: getOrSet with stampede lock, tag invalidation)
      storage/ (s3.service.ts, cdn-signer.ts)
      queue/  (bullmq.module.ts, queues.ts)
      mail/   push/ (fcm.service.ts)  sentry/  metrics/  outbox/ (relay.ts)
    realtime/
      socket-auth.ts              # handshake JWT verify
      live.gateway.ts             # namespace /live  (app)
      admin.gateway.ts            # namespace /admin (CMS)
      event-router.ts             # Redis "events" → rooms
    modules/
      auth/ admin-auth/ me/ devices/ bootstrap/ catalog/ sessions/ themes/ teachers/
      programs/ challenges/ motd/ group/ daily-messages/ sound-blocks/ sos/ media/
      meditations/ stats/ recipes/ dedications/ moderation/ presence/ vibration/
      subscriptions/ notifications/ inbox/ config/ analytics/ users-admin/ team/
      audit/ jobs/ health/
      (each: *.module.ts, *.controller.ts, *.service.ts, *.repo.ts, dto/*.ts, *.spec.ts)
    workers/                      # BullMQ processors
    scheduler/                    # repeatable job registration + leader lock
  prisma/ schema.prisma  migrations/  seed.ts
  openapi/openapi.yaml
  test/ (e2e/*.e2e.ts, socket/*.e2e.ts, k6/*.js, fixtures/revenuecat/*.json)
  docker/ (Dockerfile, docker-compose.yml)
```

### 3.2 Coding rules
**Layering**
- Controllers stay thin: they only validate input and call the service.
- Services hold the business logic.
- Repos hold the Prisma calls.
- No Prisma in controllers.

**Transactions**
- Every multi-row write goes in `prisma.$transaction`.
- Events go into the outbox inside the same transaction.

**IDs and time**
- IDs: UUID v7 (`uuid` package `v7()`). Clients may send their own v7 IDs for idempotent creates (meditations).
- Time is UTC everywhere. The user's local date is computed from `users.timezone` with `Temporal`/`date-fns-tz`.

**Data safety and logging**
- No N+1 queries. Use `include`/`relationJoins` or a batched `findMany({ where: { id: { in } } })`.
- Never log PII: no email, dedication text or tokens. Pino `redact` paths are configured.

---

## 4. Data model (PostgreSQL)

The authoritative schema is **`starter/prisma/schema.prisma`**. This section explains it.

### 4.1 Tables
| Table | Purpose | Key indexes |
|---|---|---|
| `users` | App users (guest + account), settings, reminder time + IANA tz | `(timezone, reminder_time)` push scheduler; `(is_guest, created_at)`; trigram on `first_name` |
| `auth_identities` | device / apple / google / email (+ argon2id hash) | unique `(provider, provider_uid)` |
| `devices` | install id, platform, push token, app version | unique `install_id`, unique `push_token` |
| `refresh_tokens` | rotating refresh tokens, family + reuse detection | `token_hash` unique, `family_id` |
| `email_tokens` | magic link / verify / reset / admin invite (hashed) | `token_hash` |
| `entitlements` | mirror of RevenueCat `premium` | `(active, period_type)` |
| `user_stats` | lifetime totals | PK user |
| `user_daily_stats` | per user per **local date** minutes/meditations/group | PK `(user_id, local_date)` → week/month/year = range SUM |
| `themes`, `teachers`, `sessions`, `programs`, `program_days`, `challenges`, `challenge_participants` | Content | sessions: `(status, publish_at)`, `(theme_id, status)`, GIN `tags`, trigram `title` |
| `media_assets` | every uploaded file (S3 key, duration, LUFS, blurhash, status) | `checksum` (duplicates) |
| `motd_days` + `motd_variants` | MOTD per date + 10/30/45 media | PK date; PK `(date, length_min)` |
| `daily_messages` | Daily message per date | `(status, date desc)` |
| `sound_blocks` | Build-your-own blocks | `(kind, visible, order)` |
| `meditations` | one row per meditation (client id) | `(user_id, started_at desc)`, `(session_id, started_at)` |
| `recipes` | Build your own saved recipes | `(user_id, updated_at desc)`, `share_slug` |
| `program_progress` | per user per program | PK |
| `dedications`, `dedication_holds`, `reports`, `user_blocks` | Community | `(session_id, status, created_at desc)`, `(status, created_at desc)`, unique `meditation_id` |
| `app_config` | JSON config by key: `main`, `today`, `group`, `sos`, `legal`, `moderation`, `catalog` | PK key |
| `offers` | `founding` cap/taken/open | PK |
| `subscription_events` | RevenueCat events (id = RC event id → idempotent) | `(event_at desc)`, `(user_id, event_at desc)` |
| `notifications`, `auto_notifications`, `push_log`, `inbox_items` | Push + inbox; `push_log` PK guarantees max 1 per key per local date | `(status, send_at)` |
| `admin_users`, `admin_sessions`, `audit_log` | CMS auth, sessions, audit | `audit (target_type, target_id, at desc)` |
| `jobs` | long jobs visible in CMS | `(type, status)` |
| `outbox_events` | transactional outbox → realtime | `(published_at, id)` |
| `daily_aggregates` | rollups for dashboard/analytics | PK date |
| `analytics_events` | product events from app (batched) | `(name, at)`, monthly partitions |

### 4.2 Config JSON shapes (`app_config`)
```jsonc
// key = "main"
{ "minVersion": { "ios": "1.0.0", "android": "1.0.0" }, "maintenance": false,
  "features": { "challenges": false, "gratitude": false, "breathwork": false, "milestones": false, "intent": false },
  "supportEmail": "hello@wehum.app", "defaultReminderTime": "07:00", "languages": ["en"] }
// key = "today"
{ "emptyRoomThreshold": 10, "freeHomePick": "random", "showDailyMessage": false,
  "sections": { "progress": true, "liveCounter": true, "worldMap": true } }
// key = "group"
{ "startUtc": "16:00", "lengthMin": 30, "lobbyOpenMin": 15, "reminderMin": 10 }
// key = "sos"
{ "title": "How can I help?", "subtitle": "Pick what you feel. It starts right away.",
  "help": { "title": "Need more help?", "body": "You can contact us and book a personal session with Raphael.",
            "bookingUrl": "https://…", "contactEmail": "…" } }
// key = "moderation"
{ "dailyLimit": 3, "autoHideReports": 3, "blockLinks": true, "profanity": true, "crisisWords": [ "…" ], "muteAfterHides": 3 }
// key = "legal"
{ "privacyUrl": "…", "termsUrl": "…", "healthDisclaimer": "…", "deleteInactiveGuestsMonths": 12 }
// key = "catalog"  (server-managed)
{ "version": 42, "updatedAt": "…" }
```
Every `PUT` increments `version`, writes the audit log and emits `config:changed {key, version}`.

### 4.3 Migrations & seed
- Use `prisma migrate dev` locally and `prisma migrate deploy` in CI before the API rolls out. Migrations must be **expand → migrate → contract**: no destructive change in the same release as the code that stops using a column.
- Raw-SQL migrations (add in `migrations/*/migration.sql`):
  - `CHECK (length_min IN (10,30,45))` on `motd_variants`.
  - `CHECK (char_length(text) <= 200)` on `dedications`.
  - Monthly partitions for `analytics_events`.
- `prisma/seed.ts` creates:
  - the owner admin (from env, with MFA enroll on first login);
  - 8 themes, Raphael as teacher and 20 demo sessions;
  - 14 MOTD days with 3 variants each;
  - SoS tiles, sound blocks, the config defaults (§4.2) and the founding offer (cap 1000).

### 4.4 Data lifecycle
- **Account delete (job).** Steps:
  1. Delete the user and all FK-cascaded rows, plus S3 user exports.
  2. Delete the RevenueCat subscriber (`DELETE /subscribers/{id}`).
  3. Write an audit entry that contains no PII.

  Dedications are deleted (cascade).
- **Inactive guests** (no activity for N months, no entitlement): a nightly job deletes them.
- **`analytics_events`:** 13-month retention (drop old partitions).
- **`refresh_tokens`:** expired rows are purged nightly.

---

## 5. REST API

Base URL: `https://api.wehum.app` (staging `api.staging.wehum.app`). Everything under `/v1`.

### 5.1 Conventions
| Topic | Rule |
|---|---|
| Format | JSON, `camelCase` fields, UTC ISO-8601 timestamps, dates `YYYY-MM-DD` |
| Success | `200/201 { "data": …, "meta"?: { "nextCursor": "…", "version": n } }`, `202` for async, `204` no body |
| Error | `{ "error": { "code": "PREMIUM_REQUIRED", "message": "…", "details"?: {…}, "traceId": "…" } }` |
| Pagination | Cursor (keyset): `?limit=20&cursor=…` (max 100). Never OFFSET on large tables |
| Request headers (app) | `Authorization: Bearer <access>`, `X-App-Version`, `X-Platform`, `X-Install-Id`, `X-Timezone`, `Accept-Language`, `Idempotency-Key` (POSTs that create) |
| Concurrency (CMS) | Responses carry `ETag: "v{version}"`; edits send `If-Match`; mismatch → `409 CONFLICT_VERSION` with current entity |
| Caching | `ETag` + `If-None-Match` → `304` on catalog, bootstrap, today, config; `Cache-Control: public, max-age=300, stale-while-revalidate=600` on `/v1/catalog` (CDN), `private, max-age=0` on user data |
| Compression | Fastify `@fastify/compress` (br, gzip) for responses > 1 KB |
| Version gate | `X-App-Version < minVersion` → `426 UPDATE_REQUIRED` on every app route except `/v1/bootstrap` (which returns `updateRequired: true`) |
| Maintenance | `503 MAINTENANCE` (except health, webhooks, admin) |
| Rate limits (Redis, sliding window) | auth 10/min/IP · general 120/min/user · writes 30/min/user · search 60/min · admin 600/min · webhooks unlimited (auth header) → `429 RATE_LIMITED` + `Retry-After` |
| Request size | 100 KB JSON (uploads go straight to S3) |
| CORS | allowlist: CMS origins only; app is native (no CORS) |
| Security headers | `@fastify/helmet`; HSTS; no `X-Powered-By` |

### 5.2 Auth model
**App users**
- Access token:
  - JWT EdDSA, TTL **15 min**.
  - Claims: `sub` (user id), `gst` (is guest), `prm` (premium active), `iid` (install id), `ver` (token version), `kid` header.
  - Stored in memory on the device.
- Refresh token:
  - Opaque, 256-bit, TTL **60 days**, rotated on every use.
  - Stored as `sha256` in `refresh_tokens` with `family_id`.
  - Reuse of a used token revokes the whole family → `401 TOKEN_REUSED`, and the app signs out cleanly.
  - On the device it lives in **secure storage** (Keychain / Keystore).

**Guest-first flow**
1. On first launch the app calls `POST /v1/auth/guest {installId}` and gets tokens.
2. RevenueCat `appUserID = users.id`, so purchases attach to the guest.
3. Optional attestation for abuse protection: App Attest on iOS, Play Integrity on Android (P8).

**Linking and merge**
- `POST /v1/auth/link/{apple|google|email}` attaches an identity to the current user, so purchases and history stay.
- If that identity already belongs to another user:
  1. The server answers `409 ACCOUNT_EXISTS {mergeToken}` (merge token valid 10 min).
  2. The app signs in to the existing account.
  3. The app calls `POST /v1/auth/merge {mergeToken}`.
  4. The server moves meditations, recipes, program progress, `user_daily_stats` (summed) and holds, then deletes the guest.
  5. The app calls `Purchases.logIn(newUserId)`; RevenueCat transfers per its project setting.

**Identity verification**
- Apple: verify the id token against Apple JWKS (`aud` = bundle id `app.wehum.meditation`), plus the nonce.
- Google: verify against Google JWKS (`aud` = iOS and Android client ids).
- Email:
  - Passwords use argon2id (m=19456, t=2, p=1); minimum 8 characters, checked against a small common-password list.
  - Magic links are single-use and valid 15 min.

**Guards and token state**
- `prm` in the JWT is a hint only. Premium routes re-check `entitlements.active` (Redis-cached per user for 60 s, busted on webhook).
- Force sign-out: bump `users.token_version` (kept in Redis `tv:{userId}`). Old access tokens are rejected and the socket receives `force:logout`.

**CMS admins**
- Login steps: email + password → TOTP (mandatory) → access token (TTL 10 min, in memory) + refresh token.
- Refresh token: **httpOnly, Secure, SameSite=Strict cookie** `wh_rt` on path `/v1/admin/auth`, 12 h idle / 7 d absolute.
- Lockout: 5 failed attempts → 15 min.
- Recovery codes: 10, hashed.
- Roles live in the token (`role`). Every admin route uses `@Roles(...)`. UI hiding is never trusted.
- CSRF: refresh needs the cookie plus the `X-CSRF` header (double-submit token).

### 5.3 Error codes
| HTTP | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | zod errors in `details.fields[]` |
| 401 | `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `TOKEN_REUSED`, `MFA_REQUIRED` | |
| 403 | `FORBIDDEN` (role), `PREMIUM_REQUIRED`, `ACCOUNT_REQUIRED`, `MEDITATION_REQUIRED` (dedication without finished meditation), `MUTED` | |
| 404 | `NOT_FOUND` | |
| 409 | `CONFLICT_VERSION`, `ACCOUNT_EXISTS`, `ALREADY_EXISTS`, `IN_USE` (delete theme with sessions) | |
| 410 | `GONE` (deleted user) | |
| 413 | `PAYLOAD_TOO_LARGE` | |
| 422 | `DEDICATION_LINKS`, `MEDIA_NOT_READY`, `YOUTUBE_UNAVAILABLE`, `INVALID_STATE` | |
| 426 | `UPDATE_REQUIRED` | |
| 429 | `RATE_LIMITED`, `DEDICATION_LIMIT` | |
| 500 | `INTERNAL` | always with `traceId` (Sentry event id) |
| 503 | `MAINTENANCE`, `DEPENDENCY_DOWN` | |

### 5.4 App endpoints
Auth column:
- `public`: no token.
- `device`: any app token, guest included.
- `account`: non-guest.
- `member`: active entitlement.
- `refresh`: refresh token in the body.

| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| | **Auth** | | | |
| `POST` | `/v1/auth/guest` | public | Create or resume a guest user for this install | body {installId, platform, appVersion, timezone, locale, attestation?}; returns tokens + me. Idempotent per installId |
| `POST` | `/v1/auth/refresh` | refresh | Rotate refresh token → new access + refresh | reuse of a used token revokes the whole family (401 TOKEN_REUSED) |
| `POST` | `/v1/auth/logout` | device | Revoke this device's refresh family + push token |  |
| `POST` | `/v1/auth/apple` | public | Sign in with Apple (id token + nonce) | returns tokens; body may carry guestMergeToken |
| `POST` | `/v1/auth/google` | public | Sign in with Google (id token) |  |
| `POST` | `/v1/auth/email/login` | public | Email + password login | 5 fails / 15 min / account+IP → 429 |
| `POST` | `/v1/auth/email/magic-link` | public | Send sign-in link | always 202 (no account enumeration); 60 s resend cooldown |
| `POST` | `/v1/auth/email/verify-link` | public | Exchange magic-link token for tokens | token single-use, 15 min |
| `POST` | `/v1/auth/password/forgot` | public | Send reset email | always 202 |
| `POST` | `/v1/auth/password/reset` | public | Set new password with reset token | revokes all refresh families |
| `POST` | `/v1/auth/link/apple` | device | Attach Apple identity to current (guest) user | 409 ACCOUNT_EXISTS {mergeToken} if identity belongs to another user |
| `POST` | `/v1/auth/link/google` | device | Attach Google identity to current user | same conflict rule |
| `POST` | `/v1/auth/link/email` | device | Attach email + password to current user | sends verify email |
| `POST` | `/v1/auth/merge` | account | Merge a guest's data into the signed-in account | body {mergeToken}; moves meditations, recipes, program progress, stats; deletes guest |
| | **Bootstrap** | | | |
| `GET` | `/v1/bootstrap` | device | One call on launch: me, entitlement, config, flags, min versions, catalog version, founding offer, server time | ETag; p95 < 60 ms (Redis) |
| `GET` | `/v1/time` | public | Server time (ms) for countdown sync | also via socket time:sync |
| | **Me** | | | |
| `GET` | `/v1/me` | device | Current user + entitlement + settings |  |
| `PATCH` | `/v1/me` | device | Update profile/settings | firstName, timezone, locale, country, theme, reminderEnabled, reminderTime, groupWarning, dailyMessagePush, showCountry |
| `GET` | `/v1/me/progress` | device | Progress for period=week|month|year|all | minutes, meditations, together, average, daysThisWeek[7], bars[]; no streaks |
| `POST` | `/v1/me/entitlement/sync` | device | Force re-read of RevenueCat subscriber | use after purchase if webhook not arrived yet |
| `POST` | `/v1/me/devices` | device | Register / update device + push token |  |
| `DELETE` | `/v1/me/devices/{id}` | device | Remove device push token |  |
| `GET` | `/v1/me/inbox` | device | Notification inbox (cursor) |  |
| `POST` | `/v1/me/inbox/read` | device | Mark items read | body {ids[] | all:true} |
| `POST` | `/v1/me/export` | account | Request data export (job → email link) | 1 per 24 h |
| `DELETE` | `/v1/me` | device | Delete account and all data | account users need recent auth (< 5 min) or password; returns job id |
| `POST` | `/v1/analytics/events` | device | Batch product analytics events (≤ 50) | fire-and-forget, 202 |
| | **Catalog** | | | |
| `GET` | `/v1/catalog` | device | Full catalog snapshot (themes, teachers, sessions, programs, sound blocks, SoS) | ?version= → 304 if unchanged; CDN-cached 5 min, ETag; ~150 KB gz |
| `GET` | `/v1/sessions/{id}` | device | Session detail + practicedToday + dedication preview |  |
| `GET` | `/v1/programs/{id}` | device | Program detail + my progress |  |
| `GET` | `/v1/teachers/{id}` | device | Teacher bio + sessions |  |
| `GET` | `/v1/sos` | device | SoS screen: title, subtitle, tiles, help card |  |
| `GET` | `/v1/search` | device | Server search fallback (q, filters) | app searches local catalog first; trigram index |
| | **Today** | | | |
| `GET` | `/v1/today` | device | Today payload for user's local date | MOTD + variants + live snapshot + group + freePick + program + progress card + daily message line; Redis 30 s per (date, plan) |
| `GET` | `/v1/motd/{date}` | device | MOTD for a date |  |
| `GET` | `/v1/group/next` | device | Next group meditation (startsAt UTC, length, lobby count) |  |
| `GET` | `/v1/live` | device | Live snapshot fallback when socket is down | total, countries, vibration, quiet flag |
| `GET` | `/v1/daily-messages/{date}` | member | Daily message (falls back to latest earlier) |  |
| `GET` | `/v1/daily-messages` | member | Archive (q, theme, cursor) |  |
| | **Media** | | | |
| `POST` | `/v1/media/play-url` | device | Signed CDN URL(s) for a session/variant/block | premium content → 403 PREMIUM_REQUIRED; URL valid 6 h (download: 7 d) |
| | **Meditations** | | | |
| `POST` | `/v1/meditations` | device | Record a meditation (client UUID v7 id) | idempotent by id; server computes counted/localDate; updates stats async |
| `POST` | `/v1/meditations/batch` | device | Offline sync (≤ 100) | per-item result |
| `GET` | `/v1/meditations` | device | My history (cursor) |  |
| | **Recipes** | | | |
| `GET` | `/v1/recipes` | member | My saved meditations (Build your own) |  |
| `POST` | `/v1/recipes` | member | Save recipe |  |
| `PATCH` | `/v1/recipes/{id}` | member | Rename / edit recipe |  |
| `DELETE` | `/v1/recipes/{id}` | member | Delete recipe |  |
| `POST` | `/v1/recipes/{id}/share` | member | Create share slug → wehum.app/r/{slug} |  |
| `GET` | `/v1/recipes/shared/{slug}` | device | Open shared recipe |  |
| | **Programs** | | | |
| `POST` | `/v1/programs/{id}/start` | member | Start program |  |
| `POST` | `/v1/programs/{id}/days/{day}/complete` | member | Complete program day | no rest days / no grace |
| | **Dedications** | | | |
| `GET` | `/v1/sessions/{id}/dedications` | device | Dedications for a session (cursor, 20) | excludes blocked users; anyone can read |
| `POST` | `/v1/dedications` | member+account | Post dedication after a finished meditation | body {meditationId, text ≤ 200}; 3/day (DEDICATION_LIMIT); links blocked (DEDICATION_LINKS) |
| `PUT` | `/v1/dedications/{id}/hold` | device | "Holding this" on |  |
| `DELETE` | `/v1/dedications/{id}/hold` | device | "Holding this" off |  |
| `POST` | `/v1/dedications/{id}/report` | device | Report (reason, block?) | auto-hide at 3 reports |
| `POST` | `/v1/blocks` | device | Block a user |  |
| `DELETE` | `/v1/blocks/{userId}` | device | Unblock |  |
| | **Webhooks** | | | |
| `POST` | `/webhooks/revenuecat` | webhook | RevenueCat events | Authorization header secret; idempotent by event.id; out-of-order safe |
| | **Ops** | | | |
| `GET` | `/healthz` | public | Liveness |  |
| `GET` | `/readyz` | public | Readiness (DB, Redis, S3) |  |
| `GET` | `/metrics` | internal | Prometheus metrics | private network only |

**Key payloads (app):**
```jsonc
// GET /v1/bootstrap
{ "data": {
  "serverTime": 1759680000000,
  "updateRequired": false, "maintenance": false,
  "me": { "id": "…", "firstName": "Marcus", "isGuest": true, "timezone": "Europe/Berlin", "country": "DE",
          "theme": "dark", "reminder": { "enabled": true, "time": "07:00" }, "groupWarning": false, "showCountry": true },
  "entitlement": { "active": true, "productId": "wehum_annual_founding", "periodType": "trial",
                   "expiresAt": "…", "willRenew": true, "billingIssue": false, "isFounding": true },
  "features": { "challenges": false, "gratitude": false, "breathwork": false, "milestones": false, "intent": false },
  "today": { "emptyRoomThreshold": 10, "freeHomePick": "random", "showDailyMessage": false },
  "group": { "startUtc": "16:00", "lengthMin": 30, "lobbyOpenMin": 15, "reminderMin": 10 },
  "founding": { "open": true, "left": 214, "cap": 1000 },
  "catalogVersion": 42, "configVersion": 17,
  "sos": { "title": "How can I help?", "help": { … } },
  "socket": { "url": "wss://api.wehum.app", "namespace": "/live" } } }

// GET /v1/today?date=2026-10-05   (date = user's local date; server validates ±1 day)
{ "data": {
  "date": "2026-10-05",
  "motd": { "sessionId": "…", "title": "Steady Under Pressure", "teacher": "Raphael", "theme": "Breathing",
            "cover": { "url": "…", "blurhash": "…" }, "lengths": [10, 30, 45], "access": "premium",
            "practicedToday": 1280 },
  "live": { "total": 412, "countries": 37, "quiet": false, "meditatedToday": 1280 },
  "group": { "startsAt": "2026-10-05T16:00:00Z", "lengthMin": 30, "lobbyOpensAt": "…", "waiting": 312 },
  "freePick": { "sessionId": "…", "title": "…", "youtubeId": "…", "durationSec": 900 } ,   // free users only
  "program": { "id": "…", "title": "…", "day": 4, "days": 7 } | null,
  "progress": { "minutesWeek": 74, "meditationsWeek": 6, "daysThisWeek": [true,true,false,true,true,false,false] },
  "dailyMessage": { "date": "2026-10-05", "title": "…", "type": "audio" } | null } }

// POST /v1/meditations
{ "id": "0192…(uuid v7 from device)", "sessionId": "…", "kind": "motd", "lengthVariant": 30,
  "startedAt": "…", "endedAt": "…", "durationSec": 1804, "completed": true, "offline": false }
→ 201 { "data": { "id": "…", "counted": true, "localDate": "2026-10-05",
                  "canDedicate": true, "dedicationsLeftToday": 3,
                  "together": { "people": 412, "countries": 37 } } }
```

### 5.5 Admin endpoints (CMS)
Auth column = roles allowed. `editor(read)` = GET only.

| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| | **Admin Auth** | | | |
| `POST` | `/v1/admin/auth/login` | public | Email + password → mfaToken (step 1) | lockout 5 fails / 15 min |
| `POST` | `/v1/admin/auth/mfa/verify` | public | TOTP or recovery code → access token + refresh cookie |  |
| `POST` | `/v1/admin/auth/mfa/enroll` | public | Enroll TOTP (QR) using enrollToken | mandatory for every admin |
| `POST` | `/v1/admin/auth/refresh` | refresh | Rotate refresh (httpOnly cookie) | 12 h idle timeout |
| `POST` | `/v1/admin/auth/logout` | admin:any | Sign out |  |
| `POST` | `/v1/admin/auth/forgot` | public | Reset email |  |
| `POST` | `/v1/admin/auth/reset` | public | Set password with token |  |
| `POST` | `/v1/admin/auth/accept-invite` | public | Accept invite, set password, enroll MFA |  |
| `GET` | `/v1/admin/me` | admin:any | Current admin + role + permissions |  |
| | **Team** | | | |
| `GET` | `/v1/admin/team` | admin:owner,admin | Team members |  |
| `POST` | `/v1/admin/team/invite` | admin:owner,admin | Invite admin (email, role) | admin cannot invite owner |
| `PATCH` | `/v1/admin/team/{id}` | admin:owner,admin | Change role / disable | last-owner protection |
| `DELETE` | `/v1/admin/team/{id}` | admin:owner,admin | Remove admin |  |
| | **Dashboard** | | | |
| `GET` | `/v1/admin/dashboard` | admin:owner,admin,editor,moderator | KPIs + needs-attention + top meditations + next group | moderator gets moderation KPIs only; live via socket |
| | **Analytics** | | | |
| `GET` | `/v1/admin/analytics` | admin:owner,admin,editor | Trends (period 7/30/90, tz UTC|Europe/Berlin) | reads daily_aggregates only |
| `GET` | `/v1/admin/analytics/funnel` | admin:owner,admin,editor | Funnel |  |
| `GET` | `/v1/admin/analytics/retention` | admin:owner,admin,editor | D1/D7/D30 cohorts |  |
| `GET` | `/v1/admin/analytics/export` | admin:owner,admin,editor | CSV export | streamed |
| | **Sessions** | | | |
| `GET` | `/v1/admin/sessions` | admin:owner,admin,editor | List (tab, q, theme, type, teacher, access, status, cursor, sort) |  |
| `POST` | `/v1/admin/sessions` | admin:owner,admin,editor | Create draft |  |
| `GET` | `/v1/admin/sessions/{id}` | admin:owner,admin,editor | Get (with usage: MOTD dates, programs, dedications count) |  |
| `PATCH` | `/v1/admin/sessions/{id}` | admin:owner,admin,editor | Update | If-Match: version → 409 CONFLICT_VERSION |
| `POST` | `/v1/admin/sessions/{id}/publish` | admin:owner,admin,editor | Publish now | blocked without ready media (MEDIA_NOT_READY) |
| `POST` | `/v1/admin/sessions/{id}/schedule` | admin:owner,admin,editor | Schedule publishAt |  |
| `POST` | `/v1/admin/sessions/{id}/archive` | admin:owner,admin,editor | Archive | blocked if used by future MOTD |
| `POST` | `/v1/admin/sessions/{id}/duplicate` | admin:owner,admin,editor | Duplicate as draft |  |
| `DELETE` | `/v1/admin/sessions/{id}` | admin:owner,admin | Delete draft |  |
| `POST` | `/v1/admin/sessions/bulk` | admin:owner,admin,editor | Bulk publish/archive/change theme |  |
| `POST` | `/v1/admin/youtube/resolve` | admin:owner,admin,editor | Resolve YouTube URL → title, duration, thumbnail | private/removed → 422 YOUTUBE_UNAVAILABLE |
| | **Media** | | | |
| `POST` | `/v1/admin/media/uploads` | admin:owner,admin,editor | Start upload → presigned multipart URLs | ≤ 500 MB audio/video, 10 MB image |
| `POST` | `/v1/admin/media/uploads/{id}/complete` | admin:owner,admin,editor | Complete multipart → processing job |  |
| `GET` | `/v1/admin/media/{id}` | admin:owner,admin,editor | Media status (duration, LUFS, blurhash) |  |
| | **Themes** | | | |
| `GET` | `/v1/admin/themes` | admin:owner,admin,editor | List |  |
| `POST` | `/v1/admin/themes` | admin:owner,admin,editor | Create |  |
| `PATCH` | `/v1/admin/themes/{id}` | admin:owner,admin,editor | Update |  |
| `PUT` | `/v1/admin/themes/order` | admin:owner,admin,editor | Reorder (ids[]) |  |
| `DELETE` | `/v1/admin/themes/{id}` | admin:owner,admin,editor | Delete (reassignTo required if sessions) |  |
| | **Teachers** | | | |
| `GET` | `/v1/admin/teachers` | admin:owner,admin,editor | List |  |
| `POST` | `/v1/admin/teachers` | admin:owner,admin,editor | Create |  |
| `PATCH` | `/v1/admin/teachers/{id}` | admin:owner,admin,editor | Update |  |
| | **Programs** | | | |
| `GET` | `/v1/admin/programs` | admin:owner,admin,editor | List + KPIs |  |
| `POST` | `/v1/admin/programs` | admin:owner,admin,editor | Create |  |
| `PATCH` | `/v1/admin/programs/{id}` | admin:owner,admin,editor | Update |  |
| `PUT` | `/v1/admin/programs/{id}/days` | admin:owner,admin,editor | Replace day list |  |
| | **Challenges** | | | |
| `GET` | `/v1/admin/challenges` | admin:owner,admin,editor | List (coming soon) |  |
| `POST` | `/v1/admin/challenges` | admin:owner,admin,editor | Create |  |
| `PATCH` | `/v1/admin/challenges/{id}` | admin:owner,admin,editor | Update |  |
| | **Daily Messages** | | | |
| `GET` | `/v1/admin/daily-messages` | admin:owner,admin,editor | Month (from, to) |  |
| `PUT` | `/v1/admin/daily-messages/{date}` | admin:owner,admin,editor | Upsert day |  |
| `DELETE` | `/v1/admin/daily-messages/{date}` | admin:owner,admin,editor | Delete day |  |
| | **Today Screen** | | | |
| `GET` | `/v1/admin/motd` | admin:owner,admin,editor | MOTD range (from, to) with variant status |  |
| `PUT` | `/v1/admin/motd/{date}` | admin:owner,admin,editor | Set session for date |  |
| `PUT` | `/v1/admin/motd/{date}/variants/{len}` | admin:owner,admin,editor | Attach media for 10/30/45 |  |
| `POST` | `/v1/admin/motd/swap` | admin:owner,admin,editor | Swap two dates |  |
| `GET` | `/v1/admin/config/today` | admin:owner,admin,editor | Today rules (threshold, free layout, daily message toggle) |  |
| `PUT` | `/v1/admin/config/today` | admin:owner,admin,editor | Save today rules |  |
| | **Group Meditation** | | | |
| `GET` | `/v1/admin/group` | admin:owner,admin,editor | Group config + history |  |
| `PUT` | `/v1/admin/group` | admin:owner,admin,editor | Save start time UTC, length, lobby/reminder minutes |  |
| | **Sounds** | | | |
| `GET` | `/v1/admin/sound-blocks` | admin:owner,admin,editor | List by kind |  |
| `POST` | `/v1/admin/sound-blocks` | admin:owner,admin,editor | Create |  |
| `PATCH` | `/v1/admin/sound-blocks/{id}` | admin:owner,admin,editor | Update |  |
| `PUT` | `/v1/admin/sound-blocks/order` | admin:owner,admin,editor | Reorder |  |
| | **SoS** | | | |
| `GET` | `/v1/admin/sos` | admin:owner,admin,editor | Tiles + header + help card |  |
| `PUT` | `/v1/admin/sos` | admin:owner,admin,editor | Save header + help card (booking URL, contact email) |  |
| `PUT` | `/v1/admin/sos/order` | admin:owner,admin,editor | Reorder tiles (max 8) |  |
| | **Moderation** | | | |
| `GET` | `/v1/admin/moderation` | admin:owner,admin,moderator | Queue (filter, sessionId, cursor) |  |
| `POST` | `/v1/admin/moderation/{id}/hide` | admin:owner,admin,moderator | Hide post |  |
| `POST` | `/v1/admin/moderation/{id}/keep` | admin:owner,admin,moderator | Keep (clear flags) |  |
| `POST` | `/v1/admin/moderation/bulk` | admin:owner,admin,moderator | Bulk hide/keep |  |
| `POST` | `/v1/admin/users/{id}/mute` | admin:owner,admin,moderator | Mute user in feed |  |
| `GET` | `/v1/admin/moderation/rules` | admin:owner,admin,moderator | Rules |  |
| `PUT` | `/v1/admin/moderation/rules` | admin:owner,admin | Save rules (limit, auto-hide N, word lists) |  |
| | **Subscriptions** | | | |
| `GET` | `/v1/admin/subscriptions/summary` | admin:owner,admin,editor(read) | KPIs + founding counter |  |
| `GET` | `/v1/admin/subscriptions/members` | admin:owner,admin,editor(read) | Members (tab, cursor) |  |
| `GET` | `/v1/admin/subscriptions/events` | admin:owner,admin,editor(read) | Event feed (cursor) |  |
| `POST` | `/v1/admin/offers/founding/close` | admin:owner,admin | End Founding offer now | switches RC current offering to regular |
| | **Users** | | | |
| `GET` | `/v1/admin/users` | admin:owner,admin,editor(read) | Search + tabs (cursor) | q matches email prefix / name trigram / id |
| `GET` | `/v1/admin/users/{id}` | admin:owner,admin,editor(read) | User detail |  |
| `POST` | `/v1/admin/users/{id}/gift` | admin:owner,admin | Gift premium N days (RC promotional) |  |
| `POST` | `/v1/admin/users/{id}/export` | admin:owner,admin | Export user data (job) |  |
| `DELETE` | `/v1/admin/users/{id}` | admin:owner,admin | Delete account + data (job) | typed confirmation token required |
| `GET` | `/v1/admin/users/export` | admin:owner,admin | CSV export (job) |  |
| | **Notifications** | | | |
| `GET` | `/v1/admin/notifications` | admin:owner,admin,editor | Sent + scheduled history |  |
| `POST` | `/v1/admin/notifications` | admin:owner,admin,editor | Create draft | editor: draft only |
| `PATCH` | `/v1/admin/notifications/{id}` | admin:owner,admin,editor | Edit draft/scheduled |  |
| `POST` | `/v1/admin/notifications/{id}/test` | admin:owner,admin,editor | Send test to me |  |
| `POST` | `/v1/admin/notifications/{id}/send` | admin:owner,admin | Send / schedule | audience preview count returned first |
| `POST` | `/v1/admin/notifications/{id}/cancel` | admin:owner,admin | Cancel scheduled |  |
| `GET` | `/v1/admin/notifications/automatic` | admin:owner,admin,editor | Automatic notifications |  |
| `PATCH` | `/v1/admin/notifications/automatic/{key}` | admin:owner,admin | Edit copy / toggle |  |
| | **Settings** | | | |
| `GET` | `/v1/admin/config` | admin:owner,admin | All settings (general, releases, flags, legal) |  |
| `PUT` | `/v1/admin/config/{key}` | admin:owner,admin | Save one settings group | bumps config version → socket config:changed |
| `GET` | `/v1/admin/audit` | admin:owner,admin | Audit log (filters, cursor) |  |
| | **Jobs** | | | |
| `GET` | `/v1/admin/jobs/{id}` | admin:owner,admin,editor,moderator | Job status |  |

**Uploads:** see §8.5. **Every admin mutation:**
- writes `audit_log` (before/after diff, actor, IP, request id);
- emits `entity:changed`;
- bumps `catalog.version` if it affects app content (sessions, themes, teachers, programs, sound blocks, SoS).

---

## 6. Performance & caching (make it fast)

### 6.1 Budgets (measured at the API, excluding network)
| Endpoint class | p50 | p95 | p99 |
|---|---|---|---|
| Cached reads (`bootstrap`, `today`, `catalog`, `live`, `sos`) | < 15 ms | < 50 ms | < 120 ms |
| Uncached reads (detail, lists, dedications page) | < 40 ms | < 120 ms | < 250 ms |
| Writes (`meditations`, `me`, dedications) | < 50 ms | < 150 ms | < 300 ms |
| Admin lists / dashboard | < 80 ms | < 250 ms | < 500 ms |
| Socket fan-out (event → client) | < 300 ms | < 1 s | |
| Presence aggregation lag | | < 6 s | |

**Throughput and error targets**
- Throughput target per API pod (2 vCPU): **≥ 1,500 req/s** on cached reads.
- Error rate < 0.5 %.

### 6.2 Techniques (mandatory)
**Caching**
- **Catalog snapshot.** One JSON document per `catalog.version`.
  - Built once, stored in Redis (`catalog:v{n}`, gzip) and S3, and served by CDN with ETag.
  - The app downloads it only when `bootstrap.catalogVersion` changes. Library, filters and search run **locally** on the device.
- **Redis cache-aside** (`cache.getOrSet(key, ttl, loader)`), with a stampede lock (`SET NX PX`) and tag invalidation through outbox events:
  - `today:{date}:{plan}` 30 s.
  - `motd:{date}` until change.
  - `config:*` until change.
  - `ent:{userId}` 60 s.
  - `session:{id}` until change.
  - `dedications:{sessionId}:p1` 10 s.
- **Hot counters live in Redis**, never computed with `COUNT(*)` on request: live presence, `practicedToday`, holding counts, report counts, lobby waiting. They are flushed to Postgres every 60 s.

**Database**
- **Keyset pagination**, covering indexes (§4.1), and `SELECT` only needed columns (Prisma `select`).
- **Writes:**
  - `POST /v1/meditations` inserts one row, then enqueues a `stats` job.
  - The job, in one transaction, upserts `user_daily_stats`, `user_stats` and increments the session counters. The response does not wait for it.
  - The response returns `together` and `counted` computed in memory.
- **Connection pooling:** PgBouncer; Prisma `connection_limit = 10` per pod; statement timeout 5 s (API) / 60 s (workers).
- **Read replica** (when > 2k rps) for analytics and admin lists; Prisma read-replica extension.

**Network and process**
- **Compression + HTTP keep-alive**; CDN for catalog, images, audio and video. Audio is AAC 96–128 kbps, `Cache-Control: max-age=31536000, immutable` on versioned keys.
- **No synchronous third-party calls** in user requests (RevenueCat, YouTube, FCM and email all go through queues).
- **Fastify serialization schemas** for the top 10 endpoints (fast-json-stringify).
- **Startup:** Prisma `$connect` at boot; warm caches (config, catalog) at boot.

### 6.3 Load tests (k6, P10)
| Scenario | Target |
|---|---|
| Launch storm (bootstrap + today + catalog 304) | 3,000 rps, p95 < 80 ms |
| Group start: 50,000 sockets in lobby, `group:start` broadcast | all clients receive < 1 s |
| Presence: 50,000 concurrent meditating, heartbeat 30 s | aggregation lag < 6 s, Redis CPU < 50 % |
| Meditation completion burst at group end (20k in 60 s) | p95 < 200 ms, 0 errors |
| RevenueCat webhook burst 100/s | 0 dropped, idempotent |

### 6.4 Analytics SQL
Dashboards read `daily_aggregates` only. The rollup job (hourly for today, final at 00:30 UTC) runs grouped SQL over `meditations`, `subscription_events`, `users` and `analytics_events` using the `started_at` index. Retention cohorts are precomputed nightly.

### 6.5 Scale path
| Users | Change |
|---|---|
| < 100k | 2 API pods, 1 worker, 1 scheduler, db.t4g.medium, Redis 1 GB |
| 100k–1M | 4–8 API pods (HPA on CPU/connections), read replica, partition `meditations` by month, Redis 4 GB cluster |
| > 1M | Separate socket pods (`APP_ROLE=socket`), presence sharded by country hash, analytics to ClickHouse/BigQuery |

---

## 7. Realtime (Socket.IO)

URL `wss://api.wehum.app`, path `/socket.io`, **transports: websocket only**. Two namespaces.

### 7.1 Connection & auth
- Handshake:
  - App: `io(url + '/live', { auth: { token: accessToken, installId, appVersion } })`.
  - CMS: `/admin` with an admin token.
- The middleware verifies the JWT.
  - Failure: `connect_error` with `data.code = TOKEN_EXPIRED` → the client refreshes the token and reconnects.
- On connect, the server joins:
  - `user:{userId}` (app) or `admin:{adminId}` plus `role:{role}` (CMS);
  - `config` (both).
- Heartbeat: Socket.IO ping every 25 s, timeout 20 s.
- Reconnection is handled by the client with exponential backoff (1 s → 30 s, jitter). After a reconnect the client re-emits its room joins; the server is stateless per socket.
- **Token expiry while connected:** the server emits `auth:expiring` 60 s before `exp`. The client refreshes and emits `auth:refresh {token}`. If it doesn't, the server disconnects with `TOKEN_EXPIRED`.
- Rate limit: 20 client events per 10 s per socket; excess is dropped with an `error` event.
- All client→server events use **acks** (`socket.emitWithAck`) and return `{ ok: true, data } | { ok: false, code }`.

### 7.2 `/live` namespace (mobile app)
| Direction | Event | Payload | Notes |
|---|---|---|---|
| C→S | `room:join` | `{ room: "today" \| "world" \| "motd:{date}" \| "session:{id}" \| "lobby:{date}" }` | max 4 rooms per socket; join only while that screen is visible |
| C→S | `room:leave` | `{ room }` | on screen pop / app background |
| C→S | `time:sync` | `{ t0 }` → ack `{ t0, serverTime }` | app computes offset = serverTime − (t0 + rtt/2); 3 samples, keep median |
| C→S | `presence:start` | `{ meditationId, sessionId?, kind, lengthMin?, mode: "solo"\|"group"\|"silence" }` → ack `{ together: { people, countries } }` | user counted live |
| C→S | `presence:beat` | `{ meditationId }` | every 30 s while meditating (also when app is backgrounded, via audio background task) |
| C→S | `presence:stop` | `{ meditationId }` | end / abandon |
| C→S | `lobby:join` | `{ date }` → ack `{ startsAt, waiting }` | adds to lobby count |
| C→S | `lobby:leave` | `{ date }` | |
| S→C | `live:agg` | `{ total, countries: 37, top: [{c:"DE",n:64},…], quiet, meditatedToday, vibration: 0–100, at }` | every **5 s** to `today`, `world`; only if changed |
| S→C | `session:live` | `{ sessionId, people, countries }` | every 5 s to `session:{id}` (player ring) |
| S→C | `motd:stats` | `{ date, practicedToday }` | every 30 s to `motd:{date}` |
| S→C | `lobby:state` | `{ date, waiting, countries, regions: [{r:"Europe",n:120},…], startsAt }` | every 2 s to `lobby:{date}` |
| S→C | `group:start` | `{ date, startsAt, sessionId, lengthMin, mediaKey }` | to `lobby:{date}` exactly at T0 (scheduler, ±50 ms); clients also start locally from server-synced clock as a fallback |
| S→C | `dedication:new` | `{ sessionId, dedication }` | to `session:{id}`, throttled max 1/s per room (batched array) |
| S→C | `dedication:holding` | `{ id, holdingCount }` | throttled 1/s |
| S→C | `dedication:removed` | `{ id }` | after moderation hide |
| S→C | `entitlement:changed` | `{ active, productId, periodType, expiresAt, billingIssue }` | to `user:{id}` after RC webhook |
| S→C | `inbox:new` | `{ item }` | to `user:{id}` |
| S→C | `config:changed` | `{ key, version }` | app refetches `/v1/bootstrap` |
| S→C | `catalog:changed` | `{ version }` | app refetches catalog in background (debounced 10 s) |
| S→C | `force:logout` | `{ reason }` | token version bumped / account deleted |

### 7.3 `/admin` namespace (CMS)
| Direction | Event | Payload | Rooms |
|---|---|---|---|
| C→S | `subscribe` | `{ channels: ["dashboard","moderation","subscriptions","users","jobs","entity:session:{id}", …] }` | role-checked per channel |
| C→S | `unsubscribe` | `{ channels }` | |
| C→S | `editing:start` / `editing:stop` | `{ type, id }` | presence on an entity |
| S→C | `entity:changed` | `{ type: "session"\|"theme"\|"teacher"\|"program"\|"motd"\|"dailyMessage"\|"soundBlock"\|"sos"\|"config"\|"notification"\|"challenge"\|"admin", id, op: "create"\|"update"\|"delete", version, by: { id, name } }` | `entities` (all admins) → CMS invalidates TanStack Query keys |
| S→C | `dashboard:kpis` | `{ liveNow, meditationsToday, minutesToday, payingMembers, inTrial, mrrUsd, founding: {taken, cap}, moderationOpen, at }` | `dashboard`, every 5 s |
| S→C | `live:agg` | same as app | `dashboard` |
| S→C | `moderation:new` | `{ dedication, flags }` | `moderation` |
| S→C | `moderation:count` | `{ open }` | `role:owner/admin/moderator` (sidebar badge) |
| S→C | `subs:event` | `{ event }` | `subscriptions` |
| S→C | `users:new` | `{ count }` | `users` (shows "N new" pill) |
| S→C | `job:progress` | `{ id, type, status, progress, error?, result? }` | `jobs` and `admin:{createdBy}` |
| S→C | `editing:presence` | `{ type, id, admins: [{ id, name }] }` | `entity:{type}:{id}` |
| S→C | `notification:stats` | `{ id, delivered, opened, failed }` | `entities` |

### 7.4 Presence engine (Redis)
**Keys**
```
pz:m:{meditationId}  HASH {userId, sessionId, country, mode, startedAt}     EX 90  (refreshed by presence:beat)
pz:z                 ZSET member=meditationId score=lastBeatMs                      (expiry sweep)
pz:u:{userId}        SET of active meditationIds (a user counts once)               EX 90
lobby:{date}         ZSET member=userId score=lastSeenMs
motd:{date}:users    SET userIds who practiced (counted meditation) — exact count  EX 3d
```

**Scheduler tick every 5 s** (leader only, Lua script for atomicity):
1. Run `ZRANGEBYSCORE pz:z -inf now-90s` and remove the expired members.
2. Aggregate the active members by country and by session, counting unique users. Keep running counters in `pz:agg:country` and `pz:agg:session` (HINCRBY on start/stop), and reconcile them from scratch every 60 s.
3. Publish `live:agg` and `session:live`. Write `peak_live` to `daily_aggregates`.

**Quiet flag**
- `quiet = total < today.emptyRoomThreshold`.
- When quiet, the payload's main number is `meditatedToday` (`SCARD motd:{date}:users` plus the other meditations today, from the Redis counter `med:{date}`).

**Privacy**
- Only the ISO country is stored. No coordinates. No per-user presence is ever sent to clients.

**Lifecycle hooks**
- On socket disconnect: if the socket has an active meditation, keep it for **90 s** (backgrounded app may reconnect). Expiry removes it.
- On `POST /v1/meditations` with `counted = true`: `SADD motd:{date}:users`, `INCR med:{date}`.

### 7.5 World Vibration (0–100)
- **Job:** runs every 5 min.
- **Formula:** `v = clamp(0,100, 50 * (meditationsToday / avg(meditations same hour, last 28 days)) + groupBonus)`.
  - `groupBonus = min(30, 30 * groupJoinedToday / max(1, avgGroupJoined28d))`.
- **Smoothing:** EMA α = 0.3.
- **Output:** stored in Redis `vibration:now` and included in `live:agg`.
- **Info copy (app):** "rises when more people meditate on the same day and when group meditations gather many people at once."

---

## 8. Services & jobs

### 8.1 Group meditation
- **Config:** `app_config.group.startUtc`, `lengthMin`, `lobbyOpenMin`, `reminderMin`. A per-date override comes from `motd_days.group_start_utc` / `group_length_min`.
- **Scheduler, every minute.** It finds groups that start within 15 min and creates a BullMQ **delayed job** `group:start:{date}` at the exact T0, plus `group:warn:{date}` at T0 − `reminderMin`.
- **At T0:**
  1. Emit `group:start` to `lobby:{date}`.
  2. Snapshot the lobby size to `motd_days.group_joined`.
  3. Write an inbox item `group_start` for opted-in users.
- **Late joiners:** the app seeks to `now − T0` (server-synced clock). The `GET /v1/group/next` response includes `startsAt` so the app can compute this.
- **DST:** UTC is fixed, so local display times shift. The API always returns UTC instants.

### 8.2 Stats
- Job `stats.meditation` (idempotent by meditation id, using `stats_applied` in Redis SET for 7 days):
  - upserts `user_daily_stats` (local date) and `user_stats`;
  - increments `sessions.plays`/`completions` (batched every 10 s);
  - updates the MOTD solo/group counters.
- **Counting rule:** a meditation counts when it lasted ≥ 180 s, or ≥ 50 % of a shorter session.
- `GET /v1/me/progress?period=week` is a single SQL over `user_daily_stats` for the date range. Week = ISO week in the user's timezone.

### 8.3 Push notifications
- **Tokens:** `devices.push_token` (FCM token on both platforms; iOS via APNs key uploaded to FCM).
- **Scheduler, every minute (`push.minute`).** For each distinct `users.timezone` (about 400), compute the local `HH:mm`. Then:
  - **Daily nudge:**
    - Select users with `reminder_enabled AND reminder_time = local HH:mm` (index `users_reminder_idx`).
    - Insert `push_log (user, 'daily_nudge', local_date) ON CONFLICT DO NOTHING`, which guarantees max 1 per day.
    - Enqueue sends in batches of 500 (FCM `sendEach`).
    - Copy comes from `auto_notifications.daily_nudge` with `{firstName}`.
  - **Group warning:** at T0 − 10 min, sent to users with `group_warning = true` or who tapped Remind me (`lobby:remind:{date}` SET).
  - **Daily message ready:** sent at the user's reminder time if `daily_message_push` is on and today's message is live. It merges with the nudge (one push per day) when both are due.
  - **Trial ending:** RevenueCat sends no "trial ending" event, so a daily job finds `period_type = trial AND expires_at BETWEEN now+47h AND now+49h` → push + inbox ("Trial ends in 2 days").
  - **Announcements (CMS):**
    - Audience resolves to a query.
    - `send_mode = user_reminder_time` reuses the minute scheduler.
    - Quiet hours are 22:00–07:00 local (a send due in that window is delayed until 07:00).
- **Delivery:**
  - Invalid or unregistered tokens are deleted.
  - Delivered and failed counts are written to `notifications` / `auto_notifications`.
  - `opened` comes from the app calling `POST /v1/analytics/events {name: push_open, key}`.
- **Data payload:** `{ type, deepLink, notificationId }`. The iOS `mutable-content` category is used for the ring logo.

### 8.4 Subscriptions (RevenueCat)
**Webhook `POST /webhooks/revenuecat`**
- Checks the `Authorization` header against a secret.
- Responds within 200 ms: insert `subscription_events` (`ON CONFLICT (id) DO NOTHING`), enqueue `rc.process`, return 200.

**Processor**
1. Map `app_user_id` (plus `aliases`/`transferred_from`) to the user.
2. Skip the event if `event_timestamp_ms < entitlements.last_event_at` (out of order).
3. Upsert `entitlements`: active, product, period type, expiry, `will_renew`, `billing_issue`, `is_founding = product == wehum_annual_founding`.
4. Bust `ent:{userId}` and emit `entitlement:changed`.
5. Write an inbox item for `BILLING_ISSUE` and `EXPIRATION`.

**Founding counter**
- On `INITIAL_PURCHASE` or trial conversion of `wehum_annual_founding`: `UPDATE offers SET taken = taken + 1 WHERE id='founding' RETURNING taken`.
- If `taken >= cap`, set `open=false` and call RevenueCat REST to switch the current offering to `regular`.
- Emit `subs:event` and `dashboard:kpis`.
- Race condition: the counter may briefly exceed the cap; this is accepted.

**Other flows**
- `POST /v1/me/entitlement/sync` → RevenueCat REST `GET /subscribers/{id}`, so the app is unlocked even if the webhook is late.
- Daily reconcile job: for users whose `entitlements.updated_at` is older than 24 h and who are active or expiring soon, re-read RevenueCat.
- **Gift premium (CMS):** RevenueCat promotional entitlement API, then audit.
- **Revenue KPIs** come from events (`price_in_purchased_currency` converted to USD as `price_usd`). MRR = active monthly plus annual ÷ 12.

### 8.5 Media pipeline
**Upload**
1. The CMS calls `POST /v1/admin/media/uploads {kind, mime, bytes, name, checksum}`.
2. The server validates (audio ≤ 500 MB `audio/*`; video ≤ 2 GB; image ≤ 10 MB; SVG sanitized), warns on a duplicate checksum, creates `media_assets(status=uploading)`, and returns an S3 multipart upload id plus presigned part URLs (10 MB parts).
3. The browser uploads directly to S3 (resumable, with retries per part).
4. The CMS calls `…/complete` → `status=processing` and enqueues jobs.

**Workers**
- `media_probe`: ffprobe → duration, codec.
- `media_loudness`: `ffmpeg -af ebur128` → integrated LUFS. Target −16 LUFS ±1; outside that, warn in the CMS.
- `media_transcode`: AAC-LC 128 kbps 44.1 kHz stereo (voice 96 kbps) to `media/{id}/v1/audio.m4a`. Video becomes H.264 720p/1080p MP4 (+ optional HLS).
- `image_process`: `sharp` → 1200 / 600 / 300 WebP + JPEG, plus blurhash.

**Completion and loops**
- Progress goes to `jobs` and is emitted as `job:progress`. The asset ends `ready` or `failed` (with the error shown in the CMS).
- Loop check (sound blocks): compare RMS of the first and last 200 ms; warn if not seamless.

**Delivery**
- Premium media: CloudFront signed URL valid 6 h (download 7 d) from `POST /v1/media/play-url`.
- Free covers and images: public CDN.
- Keys are versioned and immutable. Replacing a file creates a new key, so there is no cache purge.

### 8.6 Moderation
On `POST /v1/dedications` (sync, < 20 ms):
1. Check membership, account and finished meditation:
   - `meditations.id` belongs to the user;
   - the meditation is `counted`, ended < 24 h ago and has no dedication yet.
2. Check the daily limit: Redis `ded:{userId}:{localDate}` INCR, max 3.
3. Normalize the text and reject links or handles (URL regex, `www.`, `.com`, `@handle`) → `DEDICATION_LINKS`.
4. Run the profanity filter (word list + leetspeak normalization). A hit sets `status = flagged`, so the post is not shown.
5. Crisis words:
   - set `flag crisis`, `status = flagged`, and give it priority in the CMS queue;
   - the response includes `showHelp: true`, so the app shows the SoS help card.
   - Crisis posts are never silently deleted.
6. If the user is muted, the post is accepted but `hidden`.

Then emit `dedication:new` (if visible) and `moderation:new` (if flagged).

**Reports and blocks**
- Reports: unique per reporter. At `autoHideReports` (3), the post is hidden and goes to the review queue.
- Blocks: the blocked user's posts are filtered out for the blocker (`NOT EXISTS user_blocks`).
- A user whose posts are hidden `muteAfterHides` times is auto-muted.

### 8.7 Other jobs (BullMQ repeatable, scheduler leader)
| Job | Schedule |
|---|---|
| `catalog.publishDue` (scheduled sessions → live, bump version) | every minute |
| `presence.tick` | every 5 s (in-process interval on leader, not BullMQ) |
| `vibration.compute` | every 5 min |
| `counters.flush` (Redis → Postgres practicedToday, plays, holds) | every 60 s |
| `rollup.today` / `rollup.final` | hourly / 00:30 UTC |
| `push.minute` | every minute |
| `trial.ending` | hourly |
| `rc.reconcile` | daily 03:00 UTC |
| `cleanup` (expired tokens, push_log > 90 d, inactive guests, old partitions) | daily 04:00 UTC |
| `motd.check` (tomorrow missing MOTD or a length → dashboard "Needs attention" + email) | daily 12:00 UTC |

The leader election uses Redis `SET scheduler:leader <podId> NX PX 15000`, renewed every 5 s.

---

## 9. Security checklist
- **Transport:** TLS 1.2+ only; HSTS.
- **Database access:** Postgres in a private subnet; least-privilege DB user for the app (no DDL); separate migration user.
- **Secrets:** Secrets Manager / SSM. Covers the RevenueCat secret, FCM service account, JWT private keys, S3 keys and the TOTP encryption key. JWT keys rotate every 90 days (JWKS with 2 keys).
- **Input:** validation on every route; Prisma parameterization (no string SQL); `$queryRaw` with template tags only.
- **Uploads:** content-type sniffing; SVG sanitized (`dompurify` + `jsdom`); antivirus optional (ClamAV) for images.
- **Rate limits** (§5.1) plus Cloudflare/AWS WAF rules (bot fight, IP reputation).
- **Admin:** 2FA mandatory; session list and revoke in Settings; audit log is immutable (no update/delete grants).
- **Data and privacy:**
  - PII minimization: country only, no precise location.
  - Data export and delete (GDPR).
  - Privacy labels align with App Store / Play.
- **Dependencies:** `npm audit` plus Renovate; container image scan (Trivy) in CI.

---

## 10. Edge cases (backend must handle)
| Case | Handling |
|---|---|
| Duplicate meditation upload (offline retry) | PK = client id → `ON CONFLICT DO NOTHING`, return existing |
| Meditation with future `startedAt` / > 4 h | 422 `INVALID_STATE` (clock skew ±5 min tolerated) |
| User changes timezone mid-day | `local_date` computed at insert from the then-current tz; scheduler uses latest tz |
| DST shift | reminder times are local wall time; scheduler computes per tz each minute; group times UTC |
| No MOTD for a date | `/today` falls back to the most-played live premium session; dashboard alert |
| MOTD missing a length | `lengths` omits it; app hides that option; dashboard alert |
| Session archived while in someone's downloads / recipes | play-url still works for 7 d for members; catalog marks `available:false` |
| Founding cap race | accepted overshoot; offering switch idempotent |
| RC webhook before user exists (purchase right after guest create) | upsert user stub by id; entitlement row created; reconciles |
| RC `TRANSFER` (restore on another account) | move entitlement to new user, emit to both |
| Account delete with active subscription | allowed; response warns store subscription continues (app shows it) |
| Merge conflict (both users have recipes with same name) | keep both, suffix " (2)" |
| Refresh token reuse (stolen) | revoke family, force logout all devices of that family |
| Socket reconnect storm (deploy) | rolling deploy with `maxUnavailable 1`; clients jitter 0–5 s; server `connectionStateRecovery` 2 min |
| Redis down | API serves from Postgres (degraded: live counts `null` → app shows "Live counts paused"); rate limit fails open for reads, closed for auth |
| Postgres failover | Prisma retries idempotent reads once; writes return 503 `DEPENDENCY_DOWN`; app queues |
| S3/CDN down | play-url returns 503; downloads keep working offline |
| FCM token invalid | delete device token |
| Clock skew on clients | server time via `time:sync` + `serverTime` in bootstrap |
| Admin edits same entity | `If-Match` version → 409 with current entity + `editing:presence` warning |
| Large exports | streamed CSV via job → S3 signed link (24 h) |
| Deleted user's dedications in feeds | cascade delete + `dedication:removed` |
| App version below min | 426 + `updateRequired` |

---

## 11. Monitoring & observability
| Signal | Tool | Details |
|---|---|---|
| Errors | **Sentry** (`@sentry/node`) | release = git sha, environment, user id hash only. BullMQ job failures are captured with job name. Alerts: new issue, regression, spike |
| Traces | Sentry performance (or OpenTelemetry → Grafana Tempo) | sample 10 % prod, 100 % staging; spans for Prisma, Redis, S3, outbound HTTP |
| Logs | pino JSON → CloudWatch / Loki | `traceId`, `userId` hash, route, status, `durationMs`; redact `authorization`, `password`, `token`, `email`, `text` |
| Metrics | `prom-client` `/metrics` | `http_request_duration_seconds{route,method,status}`, `socket_connections{ns}`, `socket_events_total{event}`, `presence_live_total`, `presence_tick_lag_ms`, `bullmq_queue_depth{queue}`, `bullmq_job_duration{queue}`, `outbox_lag_ms`, `rc_webhook_total{type,status}`, `push_sent_total{key,status}`, `cache_hit_ratio{key}`, `db_pool_in_use` |
| Dashboards | Grafana | API latency p50/p95/p99 by route, error rate, sockets, presence, queues, DB (CPU, connections, slow queries via `pg_stat_statements`), Redis memory |
| Alerts (PagerDuty/Slack) | Grafana/CloudWatch | p95 > budget for 5 min; 5xx > 1 %; presence lag > 15 s; outbox lag > 5 s; queue depth > 5k; webhook failures; DB CPU > 80 %; Redis memory > 80 %; scheduler leader missing > 30 s; group:start not emitted at T0 |
| Uptime | Better Stack / Route53 health | `/healthz` every 30 s from 3 regions |
| Slow queries | `pg_stat_statements` + `log_min_duration_statement = 200ms` | weekly review |

---

## 12. Environments, CI/CD, local dev
- **Environments:**
  - `local`: docker-compose with `postgres:16`, `redis:7`, `minio` (S3) and `mailpit`.
  - `dev`, `staging`, `prod`: separate DBs, buckets and RevenueCat projects (sandbox for non-prod).
- **`.env`:** see `starter/.env.example`. The config is validated with zod at boot, and the app fails fast if anything is missing.
- **CI (GitHub Actions), on every PR:**
  - install, `prisma validate`, lint (eslint), typecheck, unit tests, e2e with Testcontainers, socket e2e;
  - build the image and scan it with Trivy;
  - generate `openapi.yaml` and diff it (a breaking change fails unless labelled `api-breaking`).
- **CD:**
  1. Run `prisma migrate deploy`.
  2. Deploy the api/worker/scheduler as a rolling update (ECS/Kubernetes).
  3. Smoke tests: `/readyz`, bootstrap, socket connect.
  4. Release Sentry with source maps.
- **Hosting (recommended AWS):** ECS Fargate (api ×2, worker ×1, scheduler ×1), RDS Postgres 16 (Multi-AZ in prod), ElastiCache Redis, S3 + CloudFront, ALB (idle timeout 120 s for websockets), Secrets Manager, CloudWatch. Railway, Render or Fly work equally with the same Docker image.

---

## 13. Testing strategy
| Layer | Tool | Must cover |
|---|---|---|
| Unit | Vitest | services: counting rule, local date/ISO week, empty-room rule, vibration math, moderation filters, founding counter, push scheduler tz/DST (5 tz incl. DST change days), merge |
| API e2e | Vitest + Supertest + Testcontainers (real Postgres/Redis) | every endpoint: happy path, validation, auth (no token / guest / free / member / account), role matrix for admin, pagination, ETag/304, If-Match/409 |
| Socket e2e | socket.io-client | auth fail + refresh, room join limits, presence start/beat/stop/expiry, `live:agg` cadence, lobby + `group:start` at T0 to N clients, `entity:changed` after commit only (rollback → no event) |
| Webhooks | fixtures for every RevenueCat event type | idempotency (same id twice), out-of-order, transfer, founding cap |
| Jobs | BullMQ with real Redis | media pipeline with sample files (loudness value, duration), push batch with FCM mock, export/delete cascade |
| Contract | openapi diff + generated clients compile (Dart + TS) | no unannounced breaking changes |
| Load | k6 (§6.3) | budgets met |
| Security | OWASP ZAP baseline on staging, dependency scan | no high findings |

Coverage target: services ≥ 85 % lines; all endpoints have at least one e2e test.

---

## 14. Phase plan (each phase: build → self-test → fix → report)
| Phase | Scope | Exit tests |
|---|---|---|
| **P0 Foundation** | Repo, NestJS + Fastify, config/env zod, pino, Sentry, Prisma + first migration (full schema §4), Redis, docker-compose, health/ready, envelope + error filter, CI | `docker compose up` → `/readyz` 200; CI green; Sentry test event; `prisma migrate deploy` on clean DB |
| **P1 Auth** | Guest auth, refresh rotation + reuse detection, Apple/Google/email, link + merge, rate limits, JWT keys/JWKS, version gate | e2e auth suite incl. token reuse, merge, lockout; 426 gate |
| **P2 Content & catalog** | Themes, teachers, sessions, programs, sound blocks, SoS, daily messages, MOTD + variants, catalog snapshot + version + CDN headers, play-url signing, search | catalog 304 path; signed URL premium gating; p95 budgets on catalog/today |
| **P3 Admin auth & CMS APIs** | Admin login + TOTP + cookies + CSRF, team/invite/roles, audit interceptor, all `/v1/admin/*` CRUD with If-Match, uploads + media workers | role matrix e2e (4 roles × all admin routes); upload → ready with LUFS |
| **P4 Today, meditations, stats** | `/bootstrap`, `/today`, meditations (+ batch), stats jobs, progress, free pick, group config, `/group/next` | counting rule tests; offline batch idempotency; progress week across DST |
| **P5 Realtime** | Socket.IO gateways + Redis adapter, auth middleware, rooms, presence engine, `live:agg`, `session:live`, lobby, `group:start`, time sync, outbox relay, `entity:changed`, dashboard KPIs | socket e2e suite; 2 API pods behind compose LB receive same events; k6 presence 10k |
| **P6 Subscriptions** | RevenueCat webhook + processor, entitlement cache, sync endpoint, founding counter + offering switch, gift, reconcile, subscriptions admin APIs | fixtures for all event types; founding cap test; `entitlement:changed` emitted |
| **P7 Community** | Dedications, holds, reports, blocks, moderation filters + queue + rules, mute | limit/links/crisis/auto-hide tests; blocked users filtered |
| **P8 Push & inbox** | Devices, FCM, minute scheduler, daily nudge, group warning, trial ending, announcements + audience + quiet hours, inbox, stats | scheduler tests across 5 tz + DST; one-per-day guarantee; invalid token cleanup |
| **P9 Analytics & admin data** | Analytics events ingest, rollups, dashboard, analytics/funnel/retention, users search/detail/export/delete cascade | rollup math tests; delete cascade verified (DB + S3 + RC mock) |
| **P10 Hardening** | k6 load (§6.3), caching review, slow-query review, alerts, WAF, attestation (App Attest/Play Integrity on guest create), backups + restore drill, runbooks | all budgets met; restore drill done; alerts fire in staging |
| **P11 Coming soon** | Challenges participation, gratitude feed, breathwork content, milestones | flag on/off tests |

---

## 15. Definition of done (every endpoint / event)
- zod DTO plus an OpenAPI entry, with the envelope and error codes.
- Auth and role guard; premium/account checks on the server.
- Indexed query, no N+1, within its performance budget (§6.1).
- Cache invalidation and an outbox event when the data is visible live.
- Audit log for admin mutations.
- Tests: unit (logic) plus e2e (route) plus socket where applicable.
- Logs carry no PII. Sentry stays clean in staging.

---

## 16. Phase reports (update after every phase)
```
### Phase Px — <name>
Date:
Built:
Tests run: (commands, pass/fail counts)
Performance: (p50/p95 of touched endpoints)
Bugs found → fixed:
Decisions / deviations from spec:
Open issues / risks:
Evidence: (CI run, k6 report, Sentry/Grafana links)
Status: ✅ done / ⚠️ blocked
```

### Phase P0 — Foundation
Status: ✅ done (see git history `51be123`). Covered by `test/p0-foundation.e2e.ts` (3 tests).

### Phase P1 — Auth
Date: 2026-10-05
Built: guest auth (idempotent per install id); refresh rotation with reuse detection (whole family revoked); Apple and Google sign-in against a JWKS (nonce check); email link/login/verify, magic link, password forgot/reset (signs out all devices); `ACCOUNT_EXISTS` + single-use `mergeToken` → `/v1/auth/merge`; lockout after 5 bad passwords; per-route Redis rate limits with `Retry-After`; 426 version gate; `/v1/me` GET/PATCH; `/v1/time`.
Tests run:
- `npm run typecheck` → clean.
- `npm test` → 3 files, **25 passed, 0 failed** (P1 e2e: 16 · P0 e2e: 3 · unit: 6).
- `npm run build` → OK.
- P1 e2e covers: guest idempotency + validation, `/me` auth and validation, refresh rotation + reuse, `TOKEN_EXPIRED`, logout, email link/verify/login/lockout, weak password, ACCOUNT_EXISTS → merge (moves meditations and daily stats, deletes the guest, merge token single use), magic link (single use, no account enumeration), password reset (signs out all devices), Apple and Google with a local JWKS (`SocialVerifier.useKeys`) incl. forged token and Apple link conflict, 426 gate, auth rate limit (10/min/IP).
Performance: not measured in P1 (budgets are checked in P2+ and P10).
Bugs found → fixed:
- `/healthz` and `/readyz` returned `AUTH_REQUIRED` after the global `AuthGuard` was added in P1 (a P0 test caught it). Fixed by marking `HealthController` `@Public()`.
Decisions / deviations from spec:
- The P1 e2e tests already existed in the WIP commit (the README said they were missing); this phase ran them and fixed the regression above.
- Tests run on real Postgres and Redis (docker), not Testcontainers; the `TEST_DATABASE_URL` / `TEST_REDIS_URL` env vars let them run against any instance.
Open issues / risks:
- Apple/Google verification is tested with local keys only; real provider JWKS needs a staging check once the client ids exist.
- `openapi/openapi.yaml` is not yet regenerated from `@nestjs/swagger` (to be done with the P2 contract).
Evidence: local run above; CI runs on push.
Status: ✅ done

### Phase P2 — Content & catalog
Date: 2026-10-05
Built (app read side; admin CRUD is P3):
- `GET /v1/catalog` snapshot (themes, teachers, live sessions, programs + days, sound blocks, SoS) with `ETag "c{version}"`, `?version=` and `If-None-Match` → 304 (no body), `Cache-Control: public, max-age=300, stale-while-revalidate=600`. Version = `app_config('catalog').version`; `CatalogService.bump()` is what P3 mutations call.
- `GET /v1/sessions/{id}`, `/programs/{id}` (+ my progress), `/teachers/{id}`, `/sos` (ETag), `/search` (trigram ILIKE, filters, 60/min bucket).
- `GET /v1/motd/{date}` (3 lengths, group time, live `practicedToday`), `GET /v1/daily-messages[/{date}]` (member; falls back to the latest earlier message; nothing beyond tomorrow is served; keyset archive).
- `POST /v1/media/play-url` for session / MOTD variant / sound block / daily message: premium → `403 PREMIUM_REQUIRED`, URL valid 6 h (download 7 d), YouTube items return the id only, `422 MEDIA_NOT_READY`, `422 INVALID_STATE` for non-downloadable.
- Infra: `CdnSigner` (HMAC-signed, expiring URLs), `CacheService` (cache-aside with stampede lock), `EntitlementService` (Redis 60 s) with `@Member()` / `@Account()` + `AccessGuard`, ETag helper.
Tests run (all against real Postgres 16 + Redis 7 in docker):
- `npm run typecheck` clean · `npm run build` OK.
- `npm test` → 5 files, **55 passed, 0 failed** (P2 e2e 28, P1 e2e 16, P0 e2e 3, unit 8).
- P2 e2e covers: snapshot shape + headers, no leak of storage keys / media ids / premium YouTube ids, 304 by ETag and by `?version=`, 200 after `bump()`, draft/archived/future sessions hidden, detail 404/400, program progress, teacher, SoS 304, search (filters, wildcard + injection safe), MOTD (clamp to tomorrow, bad date), practicedToday from Redis, daily-message gating / fallback / no future / pagination, play-url (free vs member, signature binds expiry, 6 h vs 7 d, YouTube, MOTD, block, daily message, not-ready, validation, entitlement cache bust + expiry).
Performance (in-process via `fastify.inject`, 150 requests each, excludes network):
| Endpoint | p50 | p95 | p99 | Budget |
|---|---|---|---|---|
| `/v1/catalog` 200 | 2.8 ms | 4.4 ms | 5.3 ms | p95 < 50 |
| `/v1/catalog` 304 | 2.2 ms | 2.8 ms | 3.4 ms | p95 < 50 |
| `/v1/sos` | 2.4 ms | 4.0 ms | 4.7 ms | p95 < 50 |
| `/v1/motd/{date}` | 2.5 ms | 3.5 ms | 3.9 ms | p95 < 50 |
| `/v1/sessions/{id}` | 3.0 ms | 4.3 ms | 5.1 ms | p95 < 50 |
| `/v1/search?q=` | 3.8 ms | 5.1 ms | 7.8 ms | p95 < 120 |
Bugs found → fixed:
- A 304 response was sent with a `{"data":null}` body (envelope wrapped the empty result). `EnvelopeInterceptor` now returns no body for 304/204.
- `db/seed.ts` computed MOTD / daily-message dates in the machine's local time zone; they are UTC now (a seeded "today" could differ from the server's UTC today).
Decisions / deviations from spec:
- Signed URLs use an HMAC scheme (`?exp=&sig=`) that a CDN edge function verifies; real CloudFront key-pair signing is swapped in at P10 (infra), the API contract (`url`, `expiresAt`) does not change. `CDN_SIGNING_SECRET` is mandatory in staging/production.
- The snapshot is cached in Redis as JSON (not gzip) plus once per process; compression happens on the wire (`@fastify/compress`). Detail caches are keyed by catalog version, so a bump invalidates them without tag invalidation.
- Visibility = `status='live'` and `publish_at <= now`. Scheduled sessions become visible on the next catalog bump; the scheduler job that bumps at `publish_at` comes with P3.
- `practicedToday` on a session is non-zero only for today's MOTD session until P4 adds per-session counters. `dedications.preview` is an empty list until P7.
- `X-Install-Id`-based and other P4+ endpoints (`/bootstrap`, `/today`, `/live`, `/group/next`) are not part of P2.
Open issues / risks:
- `openapi/openapi.yaml` is still the hand-written outline; generating it from `@nestjs/swagger` needs `@ApiResponse` DTOs on the controllers (planned with the P3 contract pass).
- The 60 s entitlement cache is busted by `EntitlementService.invalidate()`; the RevenueCat webhook (P6) must call it.
- Local note: if ports 5432/6379 are used by another stack, run the tests with `TEST_DATABASE_URL` / `TEST_REDIS_URL` pointing at other ports.
Evidence: local run above.
Status: ✅ done

### Phase P3 — Admin auth & CMS APIs
Date: 2026-10-05
Built:
- **Admin auth** (`/v1/admin/auth/*`): password → TOTP (mandatory; enrollment with QR URI + 10 hashed recovery codes), access JWT 10 min in memory, refresh token only in the `wh_rt` cookie (httpOnly, Secure, SameSite=Strict, path `/v1/admin/auth`) with double-submit CSRF (`wh_csrf` cookie + `X-CSRF`) and an origin allowlist, rotation, 12 h idle / 7 d absolute, lockout after 5 wrong passwords or codes (15 min, 429 + Retry-After), a TOTP code works only once, forgot/reset (signs out everywhere), invite → accept → enroll, `GET /v1/admin/me` with permissions. TOTP secrets are AES-256-GCM encrypted at rest.
- **Team** (`/v1/admin/team`): invite (admins cannot invite or touch owners), role change / disable / remove with last-owner and self protection; any change signs the person out (per-admin token version in Redis).
- **Audit + events**: every mutation runs through `AdminWriter` in one transaction: change + `audit_log` (changed fields only, actor, ip, request id) + `outbox_events` (`entity:changed`, `config:changed`, `catalog:changed`, `job:progress`) + catalog version bump when app content changed; caches are dropped only after commit. `GET /v1/admin/audit` (filters, cursor), `GET /v1/admin/jobs/{id}`.
- **Content CRUD with If-Match / ETag** (409 `CONFLICT_VERSION` returns the current row): sessions (list with tabs/filters/search/4 keyset sorts, create, get + usage, patch, publish, schedule, archive, duplicate, delete draft, bulk with per-item results, YouTube resolve), themes (incl. reorder, delete with `reassignTo`), teachers, programs (+ days, KPIs), challenges, daily messages, MOTD (range, set, variants 10/30/45, swap; past days locked), sound blocks, SoS (header, help card, tiles ≤ 8), config (`today`, `group` for editors; `main`, `legal`, `moderation`, `sos` for owner/admin; one strict zod schema per key).
- **Media**: `POST /v1/admin/media/uploads` (S3 multipart, 10 MB parts, presigned URLs, duplicate-checksum warning, size/mime limits), `…/complete` (verifies size, queues a job), `GET /v1/admin/media/{id}`. **Worker pipeline** (BullMQ, `APP_ROLE=worker`): ffprobe, EBU R128 loudness (warns outside −16 ±1 LUFS), loop check (first/last 200 ms), AAC-LC 128 kbps / H.264 MP4 transcode, `sharp` 1200/600/300 WebP + JPEG + blurhash; progress in `jobs` and `job:progress` events; failures end as `failed` with a readable reason.
- **Scheduler** (`APP_ROLE=scheduler`): Redis leader lease, repeatable `catalog.publishDue` every minute (scheduled sessions go live, one catalog bump).
Tests run (real Postgres 16, Redis 7, MinIO, ffmpeg/ffprobe):
- `npm run typecheck` clean · `npm run build` OK.
- `npm test` → 10 files, **117 passed, 0 failed**. P3 adds 62: admin auth 15, role matrix 4, content 30, media 10, jobs 3.
- **Role matrix**: the 4 roles × all 64 `/v1/admin/*` routes, read from the controller metadata (a new route without a role declaration fails the suite); allowed roles never get 401/403/5xx, forbidden roles get exactly 403; no token and app tokens get 401; the matrix matches the CMS capability table.
- **Upload → ready with LUFS**: a 230 s tone uploaded in 3 parts becomes `ready` with measured loudness, 229–231 s, AAC 44.1 kHz stereo in S3; a file normalised to −16 LUFS has no warning; a faded tail fails the loop check; video (h264 + aac, 640×360), image (3 sizes, blurhash), corrupt files fail with a reason; a published session built from uploads plays through `/v1/media/play-url`.
Performance: P2 numbers unchanged (p95 ≤ 4 ms on catalog / sos / motd / session). Admin lists are not load-tested yet (P10).
Bugs found → fixed:
- `npm run dev` (tsx/esbuild) could not resolve class-typed constructor injection (no decorator metadata). It had been broken since P1 because tests (swc) and the build (tsc) both work. Dev scripts now run `@swc-node/register`; all three roles boot.
- `count(*) filter (…)` comes back from `pg` as a string, so every new theme/program slug got a random suffix. Cast to int.
- The `Zod` pipe turns an absent optional query value into `{}`, which broke `DELETE /themes/{id}` without `reassignTo`. A query object schema is used instead.
- The date schema threw `RangeError` (500) on input like `from=garbage`; it now fails validation (400), also in the app's `/v1/motd/{date}`.
- Revoking admin access by `iat` rejected tokens minted in the same second as a role change. Replaced by a per-admin token version in the claim.
- Changing the group config left cached MOTD payloads (which embed the group time) stale; they are dropped now.
- `docker-compose.yml` used `minio/minio`, which is no longer on Docker Hub. It now uses `bitnamilegacy/minio` (same ports); CI got a MinIO service.
Decisions / deviations from spec:
- Only the admin routes that belong to P3 exist (auth, team, audit, jobs, content, config, media, YouTube). Dashboard, analytics, moderation, subscriptions, users and notifications come with their phases (P9, P7, P6, P9, P8); the role-matrix test picks them up automatically.
- `If-Match` is enforced when sent and optional when absent (last write wins); the CMS always sends it.
- Past MOTD days are read-only, and a session that is a future MOTD cannot be archived (`IN_USE`).
- Draft edits do not bump the catalog (they are invisible to the app); only live content does.
- `PUT /config/today` and `PUT /group` are open to editors (content); every other config key is owner/admin.
- Uploaded originals are kept in S3 (`…/v1/original.*`) next to the processed files; SVG uploads are refused until a sanitizer is added; HLS is not generated yet (`hlsKey` stays empty); voice-only 96 kbps encoding is available in code but not selected automatically.
- Admin refresh tokens are single-use; a replayed one is simply invalid (no family revocation, so two tabs refreshing at once cannot sign each other out).
- The scheduler uses BullMQ job schedulers plus a Redis lease; more jobs (§8.7) are added to it in later phases.
Open issues / risks:
- `entity:changed` / `catalog:changed` / `config:changed` / `job:progress` events are written to `outbox_events` but only relayed to sockets in P5.
- `openapi/openapi.yaml` still the hand-written outline (needs `@ApiResponse` DTOs; planned for the contract pass before the CMS client is generated).
- Real YouTube lookups are untested (fetch is mocked); duration needs `YOUTUBE_API_KEY`.
- MinIO and ffmpeg are provided by docker/npm for tests; the Docker image installs ffmpeg for production.
Evidence: local run above; CI now also starts MinIO.
Status: ✅ done

### Phase P4 — Today, meditations, stats
Date: 2026-10-05
Built:
- **`GET /v1/bootstrap`**: me, entitlement, features, today rules, group config, founding counter, catalog + config versions, SoS header, socket URL, server time. Exempt from the version gate, so an old app gets `updateRequired: true` (and `maintenance: true`) instead of an error. ETag is a hash of the payload without the clock → 304 until something changes.
- **`GET /v1/today?date=`** (date within ±1 day of the server's): MOTD (+ fallback to the most-played live premium meditation when the day is empty), live line (empty-room rule), group, free pick (stable per user and day, `random` or `newest`), program card, progress card, daily message (members, when switched on). Shared part cached 30 s per (date, plan); user part computed per request; ETag/304.
- **`GET /v1/live`** (socket-down fallback), **`GET /v1/group/next`**: group state `scheduled → lobby → live → ended` from the UTC start (per-date override beats the default), lobby `waiting` from fresh Redis entries only.
- **Meditations**: `POST /v1/meditations` (idempotent by client id: 201 new / 200 repeat / 409 other user's id; the server decides `counted` and `localDate`; returns `canDedicate`, `dedicationsLeftToday`, `together`), `POST /v1/meditations/batch` (≤ 100, per-item result), `GET /v1/meditations` (keyset history).
- **Stats** (BullMQ `stats` queue): `stats.meditation` applies `user_daily_stats` + `user_stats` + MOTD solo count exactly once (Redis marker, retry-safe); plays/completions/practicedToday are batched in Redis and flushed by `counters.flush` (every 60 s, scheduler).
- **`GET /v1/me/progress?period=week|month|year|all`**: minutes, meditations, together, average (minutes per meditation), days meditated, `daysThisWeek[7]`, bars; ISO week in the user's time zone; no streak / grace / rest-day fields anywhere.
- **User activity without a phase of its own**: programs (`/start`, `/days/{day}/complete`: one day at a time, opens the next local morning at 07:00 or immediately by rule, needs a counted meditation of that day's session) and recipes / Build your own (CRUD, share link `wehum.app/r/{slug}`, open by anyone, ≤ 100 per user). Migration `0002_program_unlock` adds `program_progress.last_day_completed_at`.
Tests run (real Postgres, Redis, MinIO, ffmpeg):
- `npm run typecheck` clean · `npm run build` OK · `npm test` → 12 files, **165 passed, 0 failed**. P4 adds 48 (meditations/stats/progress 20, Today/bootstrap/group/programs/recipes 28).
- **Counting rule**: 179 s no / 180 s yes; ≥ 50 % of a session shorter than 6 min; 120 s of a long session no.
- **Offline batch idempotency**: duplicates inside one batch, re-sending the whole batch, a bad item among good ones, 100 items, 101 rejected; stats counted once.
- **Progress week across DST**: Berlin (clocks back 2026-10-25, forward 2026-03-29), New York (2026-11-01), Sydney (2026-10-04), Tokyo, Kolkata; Sunday 23:30 vs Monday 00:30 local fall in different weeks; the stored `local_date` decides.
- Also: validation (future start, > 4 h, duration longer than the interval, ±5 min skew), local date by tz, stats retry safety, Redis hot counters, session-counter batching, live line numbers from Redis (never invented), group timing, program unlock rules, recipe validation / ownership / share links.
Performance (in-process via `fastify.inject`, 120–150 requests each, excluding network):
| Endpoint | p50 | p95 | Budget |
|---|---|---|---|
| `POST /v1/meditations` | 7.3 ms | 9.2 ms | p95 < 150 |
| `GET /v1/me/progress?period=month` | 5.3 ms | 6.4 ms | p95 < 120 |
| `GET /v1/bootstrap` (200 / 304) | 3.5 / 3.5 ms | 5.1 / 4.4 ms | p95 < 50 |
| `GET /v1/today` | 4.3 ms | 5.3 ms | p95 < 50 |
| `GET /v1/live` · `/v1/group/next` | 2.4 · 3.4 ms | 3.9 · 4.5 ms | p95 < 50 |
Bugs found → fixed:
- `canDedicate` used the JWT `gst` claim, which is stale for up to 15 minutes after linking an account; it reads the database now.
- A recipe slug could end in a half word (`sunday-om-t-xxxx`); trailing hyphens are trimmed and diacritics folded.
- `GroupService.next()` took "today" from the server clock instead of its `now` argument (not testable); fixed.
Decisions / deviations from spec:
- Presence itself is P5. P4 only reads the keys P5 will write: `pz:agg:country` (country → unique users meditating), `lobby:{date}` (user → last seen ms), `vibration:now`. Until then live numbers are honestly 0 / quiet.
- `practicedToday` = unique users with a counted meditation on that local date (`SCARD motd:{date}:users`); `meditatedToday` = all counted meditations that date (`med:{date}`). Both keyed by the user's local date, 3-day TTL.
- Plays count every recorded meditation with a session; completions only completed ones; stats (minutes, meditations) only counted ones; minutes per meditation are rounded (min 1).
- `localDate` uses the user's time zone at the time of recording and the meditation's start instant. Recording is never blocked by entitlement (offline syncs after a lapse must not be lost).
- Programs and recipes were not assigned to a phase in §14; they are here because Today and the app need them. Dedications, blocks, devices, inbox, export/delete, analytics and entitlement sync stay in P6–P9.
- `average` on the progress screen is minutes per meditation (matches the design: 105 min / 7 = 15). Month bars are 7-day blocks of the month; year and lifetime bars are calendar months up to the current one.
Open issues / risks:
- `practicedToday` on a *session* is still only filled for today's MOTD session; per-session counters arrive with presence (P5).
- Redis loss resets the hot counters (`med:*`, `motd:*:users`) until the hourly rollup (P9) rebuilds them from Postgres.
- Bootstrap's `socket.url` is derived from `PUBLIC_API_URL`; staging/prod must set it.
Evidence: local run above.
Status: ✅ done

### Phase P5 — Realtime (Socket.IO)
Date: 2026-10-05
Built:
- **Transport**: Socket.IO on the API pods, websocket only, Redis adapter, 16 KB payload limit, 25 s ping / 20 s timeout, connection-state recovery 2 min. Namespaces `/live` (app) and `/admin` (CMS); every client event is acked `{ ok, data } | { ok: false, code }`; 20 events / 10 s / socket (excess dropped with an `error` event).
- **Auth**: JWT in the handshake. `connect_error.data.code` = `AUTH_REQUIRED | TOKEN_EXPIRED | TOKEN_INVALID | UPDATE_REQUIRED | GONE`. The server emits `auth:expiring` 60 s before the token ends, accepts `auth:refresh`, otherwise sends `error TOKEN_EXPIRED` and disconnects. Revoked token version, deleted user, disabled admin and the wrong audience are refused.
- **`/live`**: `room:join/leave` (today, world, motd:{date}, session:{id}, lobby:{date}; ≤ 4 rooms; the room's current state is sent right after joining), `time:sync`, `presence:start/beat/stop`, `lobby:join/leave` (members only). Server events: `live:agg`, `session:live`, `motd:stats`, `lobby:state`, `group:start`, `config:changed`, `catalog:changed`, `force:logout` (+ routes for `entitlement:changed`, `inbox:new`, `dedication:*` that P6–P8 emit).
- **`/admin`**: role-checked `subscribe/unsubscribe` (dashboard, moderation, subscriptions, users, jobs, `entity:{type}:{id}`), `editing:start/stop` with `editing:presence` (one entry per admin, cross-pod via Redis), `entity:changed`, `job:progress` (to `jobs` and to the admin who started the job), `dashboard:kpis` (+ `live:agg`; moderators only get `moderationOpen`), `force:logout`.
- **Presence engine** (Redis, atomic Lua): a user counts once however many meditations they have; per-country and per-session unique-user counters; 90 s staleness sweep; atomic reconcile every 60 s; privacy: a hidden country is counted as a person and never shown as a country.
- **Event pipeline**: transactional outbox → relay in every API pod (`FOR UPDATE SKIP LOCKED`, woken by `NOTIFY`, 200 ms poll as safety net) → Redis channel `events` → every pod's router emits to its own sockets (`.local`). The scheduler, the workers and the API all publish to the same channel.
- **Leader ticker** (scheduler role, Redis lease): presence sweep + `live:agg` / `session:live` only when changed (a final zero for emptied sessions), `lobby:state` (2 s), `motd:stats` (30 s), dashboard KPIs (5 s; MRR estimate from a price table until P6), World Vibration (5 min, EMA), reconcile (60 s), group start scheduling (60 s).
- **Group start**: a delayed BullMQ job queued 1.5 s before T0, then a timer to the exact instant; announces once (`group:start` to `lobby:{date}`), snapshots the lobby size into `motd_days.group_joined`; a start that was moved in the CMS is recognised as stale. `bumpTokenVersion` and `revokeAdminAccess` now push `force:logout`.
Tests run (real Postgres, Redis, MinIO; real sockets via `socket.io-client`):
- `npm run typecheck` clean · `npm run build` OK · `npm test` → 14 files, **220 passed, 0 failed**. P5 adds 55: engine 25 (presence scripts, lobby, ticker, KPIs, vibration, group scheduling), sockets 30.
- **Socket e2e**: handshake failures (no / garbage / forged / expired / revoked / old version / wrong audience / deleted), websocket-only, `auth:expiring` + refresh + disconnect, time sync, room validation / 4-room limit / snapshot on join, presence over the socket incl. foreign meditations refused and 90 s expiry, lobby (members only, waiting count, regions, leave on disconnect), **`group:start` to 100 clients at T0**, events after commit only (a rolled-back write → no event; a 300-event burst arrives once each, in order), job progress routing, admin role matrix for channels, editing presence across tabs, force logout (app and CMS), rate limit, oversize payload, **two API pods**: exactly-once delivery of events with two relays and two routers, presence on pod A seen on pod B, force logout and admin events across pods, a pod stopping.
- Also checked with two **separate built processes** (`dist/main.js` on two ports, one client each): 10 outbox events → each client received 10.
Load test (`scripts/load-presence.ts`, 10,000 sockets, one machine: API + worker + scheduler + Postgres + Redis + the load generator, 100 s, real 30 s beats):
| Metric | Result | Target |
|---|---|---|
| Sockets connected | 10,000 / 10,000 (0 errors, 0 unexpected disconnects) | |
| Connect p50 / p95 / p99 | 571 / 944 / 1026 ms (during a 500-at-a-time storm) | |
| `presence:start` ack p50 / p95 / p99 | 64 / 123 / 183 ms | |
| World sees everyone after the last start | 23 ms | aggregation lag < 6 s |
| Beats (30 s interval, 100 s run) | 30,000 sent, 0 failed, **0 dropped** (the run is longer than the 90 s expiry) | |
| Everybody stops → numbers at zero | 1.9 s | |
| `group:start` to 100 lobby clients | +6…11 ms after T0 (p95 10 ms) | ±50 ms; all < 1 s |
| Atomic reconcile (Redis blocked) | 50 ms at 10k · 310 ms at 50k active | |
API process: ~75 % of one core while 10k sockets connect and beat; RSS peaks ~1.0–1.3 GB during the storm and returns to ~90 MB when idle (no leak).
Bugs found → fixed:
- The reconcile (counters rebuilt from the active entries) read first and wrote afterwards, so starts that landed in between were lost: the world showed 9,738 instead of 10,000 for up to a minute. It is now one atomic script, with a regression test (reconcile racing 300 starts and 150 stops).
- `group:start` arrived a constant ~105 ms after T0 (BullMQ delayed-job latency). The job now runs 1.5 s early and waits on a timer: +6…11 ms.
- The production Docker image had never been built: `npm ci` failed because the lockfile (written by npm 11 on macOS) did not match what Node 22's npm 10 expects (`@emnapi/*`, pulled in by `sharp`), which would also have failed in CI. The lock is now regenerated inside `node:22-bookworm-slim`; the image builds, and a container started from it answers `/readyz`, has ffmpeg 5.1 + ffprobe, and loads `sharp`.
- Presence start was called with one argument too few (caught by the first engine test run).
Decisions / deviations from spec:
- `pz:u:{userId}` is a HASH (meditation → session) instead of a SET, so unique users per session can be counted; `pz:m:*` / `pz:u:*` live 180 s (stale after 90 s) so the sweep can still read what it removes; `pz:sc:{session}` holds the per-session country counts for `session:live`.
- Country source is the user's profile; "show my country" off → bucket `XX` (counts as a person, never listed).
- All realtime goes through one Redis channel (`events`); pods emit with `.local` to avoid duplicates from the adapter. Delivery is at-least-once (publish, then mark published); all events only invalidate or patch small values on the clients.
- `presence:beat` may carry an ack: `NOT_FOUND` tells the app to send `presence:start` again.
- Lobby: pods refresh their own sockets' scores every 30 s, the leader sweeps entries older than 90 s; `room:join` of a `lobby:` room is the same as `lobby:join` (members only).
- Dashboard `mrrUsd` uses fixed monthly values of the three products (trials excluded) until RevenueCat data arrives in P6; `moderationOpen` counts auto-flagged dedications until P7.
- `entity:changed.op` is derived from the audit action (`*.create|invite|duplicate` → create, `*.delete|remove` → delete, else update).
Open issues / risks:
- `lobbyTick` reads every waiting member's country each 2 s (fine at thousands; at 50k waiting it should move to incremental counters), and the atomic reconcile blocks Redis ~310 ms per minute at 50k active: both are P10 load-test items (50k sockets, k6).
- No k6 script yet; the Node generator above is the P5 load tool. The LB compose file (`docker-compose.lb.yml` + nginx, runs the image as `staging`) validates and its image was smoke-tested alone, but the whole stack was not brought up here; the cross-pod behaviour is covered by the two-pod tests and the two-process check.
- `src/realtime/socket-events.ts` (the contract) gained `force:logout` and `error`; copy it into the CMS and the app.
- `entitlement:changed`, `inbox:new`, `dedication:*`, `moderation:*`, `subs:event`, `users:new`, `notification:stats` are routed and role-gated but produced by P6–P9.
Evidence: local run above.
Status: ✅ done

### Addendum to P5 — public totals for the CMS sign-in page (added during CMS phase P2)
Date: 2026-10-06
Built: `GET /v1/admin/public/live` (no token). Returns only `meditatedToday`, `meditatingNow` and `at`; no countries, nothing per user; rate limit 30/min per IP; `cache-control: public, max-age=10`. The CMS sign-in page shows "meditated together today" from it. `GET /v1/live` stays app-only.
Tests run: `npm test` → 221 passed, 0 failed (one new test in `p4-today.e2e.ts`; the role-matrix test now allows exactly this one public admin route).
Bugs found → fixed: none.
Decisions / deviations from spec: CMS spec §6.3 calls for a "public `GET /v1/live`"; that route needs an app token, so a separate public route with less data was added instead of opening the app route.
Open issues / risks: in one full run the P5 test "T0: every client in the lobby gets group:start within a second (100 clients)" failed once while the machine was busy with other test runs; it passed alone and in the next full run. Timing-sensitive under load.
Status: ✅ done

### Addendum to P3 — list extras and upload resume/cancel (added during CMS phase P3)
Date: 2026-10-06
Built:
- `GET /v1/admin/sessions`: `meta.total` (everything that matches the filters, same on every page) and `sos=true|false` filter.
- `GET /v1/admin/themes`: `sessionCount`, `minDurationSec`, `maxDurationSec` per theme (archived meditations not counted). `GET /v1/admin/teachers`: `sessionCount`.
- `GET /v1/admin/programs`: each day carries `session {id, title, durationSec, status, type, themeId}`. `GET /v1/admin/challenges`: `finished`.
- `POST /v1/admin/media/uploads/{id}/parts`: fresh presigned URLs for an open upload (resume after a long pause; the first URLs live one hour).
- `DELETE /v1/admin/media/uploads/{id}`: cancel an open upload (aborts in S3, removes the asset, audited as `media.cancel`, idempotent).
Tests run: `npm test` → 225 passed, 0 failed (4 new tests).
Bugs found → fixed: the test "duplicate checksum…" built a "missing" id by replacing the last character with `0`; when the real id already ended in `0` it asked for the real asset and failed (1 run in 16). It now always changes the character.
Decisions / deviations from spec: none.
Open issues / risks: `p5-sockets.e2e.ts` failed in two full runs today (the 100-client group start, and once the admin handshake test) and passed in the runs before and after with no code change in that area. These tests are timing-sensitive when the machine is busy; if it shows up in CI they need longer waits.
Status: ✅ done

### Phase P6 — Subscriptions
Date: 2026-10-06

Built:
- `POST /webhooks/revenuecat`: secret header (constant-time compare), event stored once (`ON CONFLICT (id) DO NOTHING`), job `rc.process` queued, answers at once. Migration `0004` adds `subscription_events.processed_at`.
- `RcProcessor.process`: claims the event with `processed_at` (a retried job does nothing), maps the user (app user id, aliases; a stub guest is created when the purchase comes first; RevenueCat anonymous ids stay in the log only), ignores events older than `entitlements.last_event_at`, upserts the entitlement for INITIAL_PURCHASE / RENEWAL / UNCANCELLATION / PRODUCT_CHANGE / NON_RENEWING_PURCHASE / SUBSCRIPTION_EXTENDED / TEMPORARY_ENTITLEMENT_GRANT (grant), CANCELLATION / SUBSCRIPTION_PAUSED (stop renewing), BILLING_ISSUE, EXPIRATION, TRANSFER (old account loses access, new account is re-read from RevenueCat); TEST and unknown types are only logged. Then: bust `ent:{id}`, emit `entitlement:changed` and `subs:event`.
- Founding counter on a new Founding purchase; the last slot sets `open=false` and switches the RevenueCat offering once.
- `RevenueCatClient` (REST: subscriber read, promotional grant, offering switch); `POST /v1/me/entitlement/sync`; daily `rc.reconcile` job (scheduler).
- Admin: `GET /v1/admin/subscriptions/summary | members | events` (owner, admin, editor), `POST /v1/admin/offers/founding/close` and `POST /v1/admin/users/:id/gift` (owner, admin; audited).

Tests run: `npm test` → 239 passed (227 + 12 in `p6-subscriptions.e2e.ts`): secret, full lifecycle with cache bust and socket events, idempotency, out of order, stub user, transfer, founding cap (one offering switch), sync, reconcile, summary/members/events, gift, close. The role matrix test picks up the new routes.

Decisions / deviations:
- The founding slot is counted on INITIAL_PURCHASE only (a trial that converts is the same slot); spec text says "or trial conversion", which would count it twice.
- MRR uses the latest USD price RevenueCat reported per product (monthly + annual ÷ 12, trials excluded). Plans show that price; the app never gets a price from us.
- The inbox item for BILLING_ISSUE / EXPIRATION waits for the inbox in P8.
- REST paths (`/v1/subscribers/{id}`, promotional grant, `v2/.../offerings/{key}` with `is_current`) follow RevenueCat's documentation but were only run against a fake; check them once against the RevenueCat sandbox before production. The dashboard ticker still shows its own MRR estimate from a price table; switching it to the summary's number is part of the dashboard work (P9).

Status: ✅ done

### Phase P7 — Community
Date: 2026-10-06

Built:
- App: `POST /v1/dedications` (member + account; own, counted, finished meditation of the last 24 h, one per meditation; 3 per day with the counter given back when refused; links and handles → `DEDICATION_LINKS`; profanity or crisis words → accepted but `flagged` and not shown; muted writer → accepted but `hidden`; crisis answers `showHelp: true`), `GET /v1/sessions/:id/dedications` (keyset, blocked people filtered, first name + country only, `holding` flag), `PUT/DELETE /v1/dedications/:id/hold` (idempotent, counted once per person), `POST /v1/dedications/:id/report` (unique per person, optional block; the Nth report hides the post and queues it). Session detail now carries the newest three as `dedications.preview`.
- Admin: `GET /v1/admin/moderation` (filters review / flagged / hidden / all, session, keyset; crisis posts first; reasons given by reporters), `GET …/stats`, `POST …/:id/hide|keep`, `POST …/bulk` (result per item), `POST /v1/admin/users/:id/mute`, `GET/PUT …/moderation/rules` (GET for moderators, PUT owner/admin). Hide / keep / mute are audited; `dedication:*`, `moderation:new` and `moderation:count` are published; N hides by moderators mute the writer automatically. The dashboard's `moderationOpen` now counts the same "needs review" set.
- `modules/community/text-filters.ts` (links incl. spelled-out dots, whole-word profanity with leetspeak and spaced letters, crisis phrases from the settings).

Tests run: `npm test` → 258 passed (239 + 19 in `p7-community.e2e.ts`).

Decisions / deviations:
- The profanity list is a built-in short English list (the settings only switch the filter on or off); crisis phrases come from the settings. Other languages need their own lists later.
- "Needs review" = auto-flagged, or hidden by reports and not yet looked at. A post hidden because the writer is muted is not in the queue.
- `DEDICATION_LIMIT` is counted per meditation's local day (the same Redis key as `dedicationsLeftToday`).

Status: ✅ done
