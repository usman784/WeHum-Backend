import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import type { Socket } from 'socket.io-client';
import { v7 as uuid } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearRates, guest, http, member, resetTestDb } from './helpers';
import { connectRecorded, sleep, startPod } from './realtime-helpers';

let pod: Awaited<ReturnType<typeof startPod>>;
let app: NestFastifyApplication;
let db: Client;
let sockets: Socket[] = [];
const h = () => http(app);
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const sessionOf = async (access: 'free' | 'premium', skip = 0) => (await q<{ id: string }>(`SELECT id FROM sessions WHERE status='live' AND NOT is_sos AND access=$1 ORDER BY slug OFFSET $2 LIMIT 1`, [access, skip]))[0]!;
/** A sit that ended five minutes ago and lasted `sec` seconds. */
const sit = (sessionId: string | undefined, over: Record<string, unknown> = {}, sec = 600) => ({
  id: uuid(), sessionId, kind: 'solo', startedAt: new Date(Date.now() - 5 * 60_000 - sec * 1000).toISOString(), endedAt: new Date(Date.now() - 5 * 60_000).toISOString(), durationSec: sec, completed: true, ...over,
});
const device = async (token: string) => {
  const c = await connectRecorded(pod.url, '/live', { token }, 'practiced:changed');
  sockets.push(c.socket);
  return c.rec;
};

beforeAll(async () => {
  await resetTestDb();
  pod = await startPod();
  app = pod.app;
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
beforeEach(async () => { await clearRates(); });
afterEach(async () => { for (const s of sockets) s.close(); sockets = []; await sleep(20); });
afterAll(async () => { await db?.end(); await pod?.stop(); });

describe('P17 practiced meditations', () => {
  it('lists finished meditations (free and premium), one row per meditation with a count', async () => {
    const g = await member(app, db);
    const free = await sessionOf('free'), premium = await sessionOf('premium');
    const get = async () => (await h().get('/v1/meditations/practiced', { token: g.accessToken })).body.data.items as { sessionId: string; count: number; lastAt: string }[];
    expect(await get()).toEqual([]);

    expect((await h().post('/v1/meditations', sit(free.id), { token: g.accessToken })).status).toBe(201);
    expect((await h().post('/v1/meditations', sit(premium.id), { token: g.accessToken })).status).toBe(201);
    expect((await h().post('/v1/meditations', sit(premium.id), { token: g.accessToken })).status).toBe(201);

    const items = await get();
    expect(items.map((i) => i.sessionId).sort()).toEqual([free.id, premium.id].sort());
    expect(items.find((i) => i.sessionId === premium.id)!.count).toBe(2);
    expect(items.find((i) => i.sessionId === free.id)!.count).toBe(1);
    expect(new Date(items[0]!.lastAt).getTime()).toBeGreaterThan(Date.now() - 3_600_000);
  });

  it('ignores unfinished, too-short and session-less sits, and other people’s sits', async () => {
    const g = await guest(app), other = await guest(app);
    const s = await sessionOf('free', 0), s2 = await sessionOf('free', 1);
    await h().post('/v1/meditations', sit(s.id, { completed: false }), { token: g.accessToken }); // stopped early
    await h().post('/v1/meditations', sit(s2.id, {}, 60), { token: g.accessToken }); // too short to count
    await h().post('/v1/meditations', sit(undefined), { token: g.accessToken }); // no session (e.g. silence room)
    await h().post('/v1/meditations', sit(s.id), { token: other.accessToken });
    const mine = await h().get('/v1/meditations/practiced', { token: g.accessToken });
    expect(mine.status).toBe(200);
    expect(mine.body.data.items).toEqual([]);
    const theirs = await h().get('/v1/meditations/practiced', { token: other.accessToken });
    expect(theirs.body.data.items.map((i: { sessionId: string }) => i.sessionId)).toEqual([s.id]);
    expect((await h().get('/v1/meditations/practiced')).status).toBe(401);
  });

  it('pushes practiced:changed to every device of the person at once, and to nobody else', async () => {
    const g = await guest(app), other = await guest(app);
    const phone = await device(g.accessToken), tablet = await device(g.accessToken), stranger = await device(other.accessToken);
    const free = await sessionOf('free');
    const body = sit(free.id);

    const started = Date.now();
    await h().post('/v1/meditations', body, { token: g.accessToken });
    const [a] = await phone.wait('practiced:changed');
    const [b] = await tablet.wait('practiced:changed');
    expect(a).toMatchObject({ sessionId: free.id });
    expect(b).toMatchObject({ sessionId: free.id });
    expect(Date.now() - started).toBeLessThan(2000);

    // replay of the same client id (offline retry) is not a new practice
    expect((await h().post('/v1/meditations', body, { token: g.accessToken })).status).toBe(200);
    // unfinished and too-short sits are not practiced
    await h().post('/v1/meditations', sit(free.id, { completed: false }), { token: g.accessToken });
    await h().post('/v1/meditations', sit(free.id, {}, 30), { token: g.accessToken });
    await sleep(300);
    expect(phone.of('practiced:changed')).toHaveLength(1);
    expect(tablet.of('practiced:changed')).toHaveLength(1);
    expect(stranger.of('practiced:changed')).toHaveLength(0);
  });
});
