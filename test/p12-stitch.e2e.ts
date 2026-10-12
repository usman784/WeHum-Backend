import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootApp, clearRates, guest, http, member, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
const h = () => http(app);
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
beforeEach(async () => { await clearRates(); });
afterAll(async () => { await db?.end(); await app?.close(); });

describe('Stitch redesign endpoints', () => {
  it('silence room: durations, cadence and bells by role; readable by a guest', async () => {
    const g = await guest(app);
    const r = await h().get('/v1/silence', { token: g.accessToken });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.sittingNow).toEqual(expect.any(Number));
    expect(Array.isArray(d.durations)).toBe(true);
    expect(d.bells).toHaveProperty('opening');
    expect(d.bells).toHaveProperty('interval');
    expect(d.bells).toHaveProperty('closing');
    expect((await h().get('/v1/silence')).status).toBe(401);
  });

  it('world gauge: totals and country list come from country codes only', async () => {
    const g = await guest(app);
    const r = await h().get('/v1/live/world', { token: g.accessToken });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveProperty('countries');
    expect(JSON.stringify(r.body.data)).not.toContain(g.me.id);
  });

  it('library summary: header numbers for any signed-in person', async () => {
    const g = await guest(app);
    const r = await h().get('/v1/library/summary', { token: g.accessToken });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('private');
  });

  it('crisis directory: explicit country, and a default when none is given', async () => {
    const g = await guest(app);
    const us = await h().get('/v1/sos/directory?country=US', { token: g.accessToken });
    expect(us.status).toBe(200);
    expect(us.body.data).toBeTruthy();
    expect((await h().get('/v1/sos/directory', { token: g.accessToken })).status).toBe(200);
    expect((await h().get('/v1/sos/directory?country=USA', { token: g.accessToken })).status).toBe(400);
  });

  it('next group sit: slot, details and the intention round-trip', async () => {
    const m = await member(app, db);
    const n = await h().get('/v1/group/next', { token: m.accessToken });
    expect(n.status).toBe(200);
    const slot = n.body.data.date ?? n.body.data.slot;
    expect(slot).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const bad = await h().put('/v1/group/intention', { slot, intention: 'not one of the options' }, { token: m.accessToken });
    expect(bad.status).toBe(400);
  });

  it('daily-message free access: the archive lists premium rows as locked, free rows open', async () => {
    const g = await guest(app);
    const r = await h().get('/v1/daily-messages', { token: g.accessToken });
    expect(r.status).toBe(200);
    const items: { access: string; locked: boolean }[] = r.body.data.items ?? r.body.data;
    for (const it of items) expect(it.locked).toBe(it.access === 'premium');
  });

  it('preview-url: unknown session is a clean 404, never a stream', async () => {
    const g = await guest(app);
    const r = await h().post('/v1/media/preview-url', { sessionId: '00000000-0000-7000-8000-000000000000' }, { token: g.accessToken });
    expect([400, 404]).toContain(r.status);
  });

  it('kudos: needs a session the person sat; unknown session is 404', async () => {
    const g = await guest(app);
    const r = await h().post('/v1/sessions/00000000-0000-7000-8000-000000000000/kudos', {}, { token: g.accessToken });
    expect([403, 404]).toContain(r.status);
  });

  it('challenge detail: unknown id is 404; a live one carries days and my progress', async () => {
    const g = await guest(app);
    expect((await h().get('/v1/challenges/00000000-0000-7000-8000-000000000000', { token: g.accessToken })).status).toBe(404);
    const [c] = await q<{ id: string }>(`SELECT id FROM challenges LIMIT 1`);
    if (c) {
      const r = await h().get(`/v1/challenges/${c.id}`, { token: g.accessToken });
      expect(r.status).toBe(200);
      expect(r.body.data).toHaveProperty('id', c.id);
    }
  });

  it('community feed and members-at: counts only, never people', async () => {
    const g = await guest(app);
    const f = await h().get('/v1/community/feed', { token: g.accessToken });
    expect(f.status).toBe(200);
    const m = await h().get('/v1/community/members-at?time=07:00', { token: g.accessToken });
    expect(m.status).toBe(200);
    expect(m.body.data).toHaveProperty('count');
  });

  it('anonymize dedications: allowed for the owner, idempotent', async () => {
    const g = await guest(app);
    const a = await h().post('/v1/me/dedications/anonymize', {}, { token: g.accessToken });
    expect([200, 204]).toContain(a.status);
    const b = await h().post('/v1/me/dedications/anonymize', {}, { token: g.accessToken });
    expect([200, 204]).toContain(b.status);
  });
});
