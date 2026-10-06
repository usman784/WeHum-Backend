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

  it('CORS preflight from the CMS allows PUT, PATCH and DELETE with If-Match', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await http(app).request('OPTIONS', '/v1/admin/sessions/x', {
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': method, 'access-control-request-headers': 'if-match,content-type,authorization' },
      });
      expect(r.status).toBe(204);
      expect(r.headers['access-control-allow-methods']).toContain(method);
      expect(String(r.headers['access-control-allow-headers']).toLowerCase()).toContain('if-match');
    }
  });

  it('security headers present', async () => {
    const r = await http(app).get('/healthz');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});
