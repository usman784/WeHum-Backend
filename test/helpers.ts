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
