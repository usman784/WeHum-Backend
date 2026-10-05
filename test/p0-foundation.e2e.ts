import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, http, resetTestDb } from './helpers';

describe('P0 foundation', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => { await resetTestDb(); app = await bootApp(); });
  afterAll(async () => { await app?.close(); });

  it('healthz / readyz', async () => {
    const h = http(app);
    expect((await h.get('/healthz')).body).toEqual({ ok: true });
    expect((await h.get('/readyz')).body).toMatchObject({ ok: true, db: true, redis: true });
  });

  it('unknown route → standard error envelope with traceId', async () => {
    const r = await http(app).get('/v1/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(r.body.error.traceId).toBeTruthy();
    expect(r.headers['x-request-id']).toBe(r.body.error.traceId);
  });

  it('security headers present', async () => {
    const r = await http(app).get('/healthz');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});
