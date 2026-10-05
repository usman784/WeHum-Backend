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

/** Thin wrapper over fastify.inject returning parsed JSON. */
export function http(app: NestFastifyApplication) {
  const f = app.getHttpAdapter().getInstance();
  const call = async (method: string, url: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) => {
    const res = await f.inject({
      method: method as 'GET', url, payload: opts.body as object | undefined,
      headers: { 'x-app-version': '1.0.0', 'x-platform': 'ios', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
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
