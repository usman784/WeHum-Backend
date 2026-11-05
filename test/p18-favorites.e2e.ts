import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootApp, clearRates, guest, http, member, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
const h = () => http(app);
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const sessionOf = async (skip = 0) => (await q<{ id: string }>(`SELECT id FROM sessions WHERE status='live' AND NOT is_sos ORDER BY slug OFFSET $1 LIMIT 1`, [skip]))[0]!;

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
beforeEach(async () => { await clearRates(); });
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P18 favourite meditations', () => {
  it('a member favourites and un-favourites; the list is newest first and repeats are harmless', async () => {
    const m = await member(app, db);
    const a = await sessionOf(0), b = await sessionOf(1);
    const list = async () => (await h().get('/v1/me/favorites', { token: m.accessToken })).body.data.items.map((s: { id: string }) => s.id) as string[];
    expect(await list()).toEqual([]);

    const put = await h().put(`/v1/sessions/${a.id}/favorite`, undefined, { token: m.accessToken });
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual({ sessionId: a.id, favorited: true });
    expect((await h().put(`/v1/sessions/${a.id}/favorite`, undefined, { token: m.accessToken })).status).toBe(200); // twice = still one
    await h().put(`/v1/sessions/${b.id}/favorite`, undefined, { token: m.accessToken });
    expect(await list()).toEqual([b.id, a.id]);
    expect((await q('SELECT 1 FROM favorite_sessions WHERE user_id=$1', [m.me.id])).length).toBe(2);

    const del = await h().del(`/v1/sessions/${a.id}/favorite`, { token: m.accessToken });
    expect(del.body.data).toEqual({ sessionId: a.id, favorited: false });
    expect((await h().del(`/v1/sessions/${a.id}/favorite`, { token: m.accessToken })).status).toBe(200); // not a favourite any more: no error
    expect(await list()).toEqual([b.id]);
  });

  it('a list item is a normal session summary', async () => {
    const m = await member(app, db);
    const a = await sessionOf(2);
    await h().put(`/v1/sessions/${a.id}/favorite`, undefined, { token: m.accessToken });
    const [item] = (await h().get('/v1/me/favorites', { token: m.accessToken })).body.data.items;
    expect(item).toMatchObject({ id: a.id, title: expect.any(String), access: expect.stringMatching(/free|premium/) });
  });

  it('a free account and a guest cannot favourite or read favourites (PREMIUM_REQUIRED), and nothing is stored', async () => {
    const g = await guest(app);
    const a = await sessionOf(0);
    for (const r of [
      await h().put(`/v1/sessions/${a.id}/favorite`, undefined, { token: g.accessToken }),
      await h().del(`/v1/sessions/${a.id}/favorite`, { token: g.accessToken }),
      await h().get('/v1/me/favorites', { token: g.accessToken }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('PREMIUM_REQUIRED');
    }
    expect((await q('SELECT 1 FROM favorite_sessions WHERE user_id=$1', [g.me.id])).length).toBe(0);
    expect((await h().get('/v1/me/favorites')).status).toBe(401);
  });

  it('favourites are private to each person', async () => {
    const m1 = await member(app, db), m2 = await member(app, db);
    const a = await sessionOf(0);
    await h().put(`/v1/sessions/${a.id}/favorite`, undefined, { token: m1.accessToken });
    expect((await h().get('/v1/me/favorites', { token: m2.accessToken })).body.data.items).toEqual([]);
  });

  it('rejects an unknown meditation, a bad id and a draft; a meditation taken offline drops out of the list but returns with it', async () => {
    const m = await member(app, db);
    expect((await h().put('/v1/sessions/00000000-0000-4000-8000-000000000000/favorite', undefined, { token: m.accessToken })).status).toBe(404);
    expect((await h().put('/v1/sessions/not-a-uuid/favorite', undefined, { token: m.accessToken })).status).toBe(400);
    const a = await sessionOf(0);
    await h().put(`/v1/sessions/${a.id}/favorite`, undefined, { token: m.accessToken });
    await db.query(`UPDATE sessions SET status='draft' WHERE id=$1`, [a.id]);
    expect((await h().get('/v1/me/favorites', { token: m.accessToken })).body.data.items).toEqual([]);
    expect((await h().put(`/v1/sessions/${a.id}/favorite`, undefined, { token: m.accessToken })).status).toBe(404);
    await db.query(`UPDATE sessions SET status='live' WHERE id=$1`, [a.id]);
    expect((await h().get('/v1/me/favorites', { token: m.accessToken })).body.data.items.map((s: { id: string }) => s.id)).toEqual([a.id]);
  });

  it('a member whose membership ended loses access but keeps the saved list', async () => {
    const m = await member(app, db);
    const a = await sessionOf(0);
    await h().put(`/v1/sessions/${a.id}/favorite`, undefined, { token: m.accessToken });
    await db.query(`UPDATE entitlements SET active=false, expires_at=now() - interval '1 day' WHERE user_id=$1`, [m.me.id]);
    const r = new Redis(process.env.REDIS_URL!); await r.del(`ent:${m.me.id}`); await r.quit(); // the server drops this cache when access really ends
    expect((await h().get('/v1/me/favorites', { token: m.accessToken })).status).toBe(403);
    expect((await q('SELECT 1 FROM favorite_sessions WHERE user_id=$1', [m.me.id])).length).toBe(1);
  });
});
