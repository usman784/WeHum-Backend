import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { Client } from 'pg';
import { createApp } from '../src/app.factory';
import { runMigrations } from '../src/db/migrate';
import { seed } from '../src/db/seed';

/** Fresh test DB (drop + migrate + seed) and flushed Redis DB 15. */
export async function resetTestDb() {
  const url = process.env.DATABASE_URL!;
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  await c.end();
  await runMigrations(url);
  await seed(url);
  const r = new Redis(process.env.REDIS_URL!);
  await r.flushdb();
  await r.quit();
}

export async function bootApp(): Promise<NestFastifyApplication> {
  const app = await createApp({ logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const rnd = () => Math.floor(Math.random() * 250) + 1;

/** Thin wrapper over fastify.inject returning parsed JSON. */
export function http(app: NestFastifyApplication) {
  const f = app.getHttpAdapter().getInstance();
  const call = async (method: string, url: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) => {
    const res = await f.inject({
      method: method as 'GET', url, payload: opts.body as object | undefined,
      headers: { 'x-app-version': '1.0.0', 'x-platform': 'ios', 'x-forwarded-for': `10.${rnd()}.${rnd()}.${rnd()}`, ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    });
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = res.json(); } catch { json = res.body; }
    return { status: res.statusCode, body: json, headers: res.headers };
  };
  return {
    /** Any verb by name (GET/POST/PUT/PATCH/DELETE). */
    request: (method: string, u: string, o?: Parameters<typeof call>[2]) => call(method, u, o),
    get: (u: string, o?: Parameters<typeof call>[2]) => call('GET', u, o),
    post: (u: string, body?: unknown, o?: Parameters<typeof call>[2]) => call('POST', u, { ...o, body }),
    patch: (u: string, body?: unknown, o?: Parameters<typeof call>[2]) => call('PATCH', u, { ...o, body }),
    put: (u: string, body?: unknown, o?: Parameters<typeof call>[2]) => call('PUT', u, { ...o, body }),
    del: (u: string, o?: Parameters<typeof call>[2]) => call('DELETE', u, o),
  };
}

/** Creates a guest session and returns tokens + install id. */
export async function guest(app: NestFastifyApplication, installId = `inst-${Math.random().toString(36).slice(2, 12)}`) {
  const r = await http(app).post('/v1/auth/guest', { installId, platform: 'ios', appVersion: '1.0.0', timezone: 'Europe/Berlin' });
  if (r.status !== 201) throw new Error(`guest failed ${r.status} ${JSON.stringify(r.body)}`);
  return { ...r.body.data as { accessToken: string; refreshToken: string; me: { id: string; isGuest: boolean } }, installId };
}

// ───────────── admin helpers (P3) ─────────────
import argon2 from 'argon2';
import { generateSecret, generateSync } from 'otplib';
import { v7 as uuidV7 } from 'uuid';
import { encryptSecret } from '../src/modules/admin-auth/totp-crypto';
import { TokensService } from '../src/modules/auth/tokens.service';

export type AdminRole = 'owner' | 'admin' | 'editor' | 'moderator';
export const ADMIN_PASSWORD = 'Correct-Horse-42';

/** TOTP code for the current 30 s step (+n steps). A code works once, so use different steps for repeated logins. */
export const totp = (secret: string, step = 0) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + step * 30 });

/** Active admin with MFA already enrolled (inserted directly). */
export async function makeAdmin(db: Client, role: AdminRole, email = `${role}-${Math.random().toString(36).slice(2, 8)}@wehum.test`) {
  const id = uuidV7(), secret = generateSecret();
  await db.query(
    `INSERT INTO admin_users (id, email, name, role, status, password_hash, totp_secret, mfa_enabled) VALUES ($1,$2,$3,$4,'active',$5,$6,true)`,
    [id, email, `Test ${role}`, role, await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id }), encryptSecret(secret)],
  );
  return { id, email, role, secret, password: ADMIN_PASSWORD };
}

/** Access token without going through login (role-matrix tests). */
export const adminToken = async (app: NestFastifyApplication, a: { id: string; role: AdminRole }) => {
  const tokens = app.get(TokensService);
  return tokens.signAccess({ sub: a.id, role: a.role, name: `Test ${a.role}`, ver: await tokens.adminVersion(a.id) }, 'wehum-cms');
};

/** Parses `set-cookie` headers into { name: { value, flags } }. */
export function cookiesOf(headers: Record<string, unknown>) {
  const raw = ([] as string[]).concat((headers['set-cookie'] as string | string[] | undefined) ?? []);
  const out: Record<string, { value: string; flags: string }> = {};
  for (const c of raw) { const [pair, ...rest] = c.split(';'); const i = pair!.indexOf('='); out[pair!.slice(0, i)] = { value: pair!.slice(i + 1), flags: rest.join(';').toLowerCase() }; }
  return out;
}
