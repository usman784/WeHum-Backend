import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/infra/mailer';
import { PushTransport } from '../src/modules/push/push.transport';
import { RevenueCatClient } from '../src/modules/subscriptions/revenuecat.client';
import { UserDataService } from '../src/modules/users-admin/user-data.service';
import { bootApp, guest, http, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
afterAll(async () => { await db?.end(); await app?.close(); });

describe('Privacy & data (app screen 59)', () => {
  it('export: 202 + job, status poll returns links once done, email goes to people with an address', async () => {
    const g = await guest(app);
    await db.query('UPDATE users SET email = $1 WHERE id = $2', ['lena@example.com', g.me.id]);
    const r = await http(app).post('/v1/me/export', undefined, { token: g.accessToken });
    expect(r.status).toBe(202);
    const jobId = r.body.data.jobId as string;
    expect((await http(app).get(`/v1/me/export/${jobId}`, { token: g.accessToken })).body.data.status).toBe('queued');
    Mailer.outbox.length = 0;
    await app.get(UserDataService).exportUser(jobId, g.me.id, 'lena@example.com'); // the worker does this in production
    const s = await http(app).get(`/v1/me/export/${jobId}`, { token: g.accessToken });
    expect(s.body.data.status).toBe('done');
    expect(s.body.data.result.json).toMatch(/^http/);
    expect(Mailer.outbox.at(-1)?.to).toBe('lena@example.com');
    expect(Mailer.outbox.at(-1)?.text).toContain('24 hours');
  });

  it("nobody can read someone else's export", async () => {
    const a = await guest(app), b = await guest(app);
    const jobId = (await http(app).post('/v1/me/export', undefined, { token: a.accessToken })).body.data.jobId;
    expect((await http(app).get(`/v1/me/export/${jobId}`, { token: b.accessToken })).status).toBe(404);
  });

  it('delete: needs the word DELETE, stops the account at once, job removes it and leaves the push topic', async () => {
    const g = await guest(app);
    app.get(RevenueCatClient).fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch; // RevenueCat forgets the subscriber (no network in tests)
    const ops: { op: string; tokens: string[] }[] = [];
    app.get(PushTransport).topicImpl = async (op, _t, tokens) => { ops.push({ op, tokens }); return true; };
    await http(app).post('/v1/me/devices', { installId: g.installId, platform: 'ios', appVersion: '1.0.0', pushToken: 'fcm-token-delete-0001' }, { token: g.accessToken });
    ops.length = 0;

    expect((await http(app).request('DELETE', '/v1/me', { body: { confirm: 'yes' }, token: g.accessToken })).status).toBe(400);
    const r = await http(app).request('DELETE', '/v1/me', { body: { confirm: 'DELETE' }, token: g.accessToken });
    expect(r.status).toBe(202);
    // the account stops working immediately
    expect((await http(app).get('/v1/me', { token: g.accessToken })).status).toBeGreaterThanOrEqual(400);

    await app.get(UserDataService).deleteUser(r.body.data.jobId, g.me.id, null);
    expect((await db.query('SELECT 1 FROM users WHERE id = $1', [g.me.id])).rowCount).toBe(0);
    expect(ops).toContainEqual({ op: 'unsubscribe', tokens: ['fcm-token-delete-0001'] });
  });
});
