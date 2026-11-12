// Who has the app open right now (CMS: green dot, "Online now" tab, Dashboard map). Online = a connected /live socket.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type Redis from 'ioredis';
import { Client } from 'pg';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { K, REDIS } from '../src/infra/redis';
import { ONLINE_STALE_MS, OnlineService } from '../src/realtime/online.service';
import { RealtimeTicker } from '../src/realtime/ticker';
import { account, adminToken, clearRates, guest, http, makeAdmin, resetTestDb } from './helpers';
import { randomUUID as uuid } from 'node:crypto';
import { emit, mustConnect, recorder, sleep, startPod, waitFor } from './realtime-helpers';

let pod: Awaited<ReturnType<typeof startPod>>;
let app: NestFastifyApplication;
let db: Client;
let redis: Redis;
let online: OnlineService;
let sockets: Socket[] = [];
const track = (s: Socket) => { sockets.push(s); return s; };
const live = async (token: string, url = pod.url) => track(await mustConnect(url, '/live', { token }));
const setCountry = (id: string, c: string | null, show = true) => db.query('UPDATE users SET country = $2, show_country = $3 WHERE id = $1', [id, c, show]);

beforeAll(async () => {
  await resetTestDb();
  pod = await startPod();
  app = pod.app;
  redis = app.get(REDIS);
  online = app.get(OnlineService);
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
beforeEach(async () => { await clearRates(); await redis.del(K.onlineZ, K.onlineMeta, K.onlineCity, K.dashKpisLast, ...(await redis.keys('on:s:*'))); (app.get(RealtimeTicker) as any).lastKpis = ''; }); // eslint-disable-line @typescript-eslint/no-explicit-any
afterEach(async () => { for (const s of sockets) s.close(); sockets = []; await sleep(50); });
afterAll(async () => { await db?.end(); await pod?.stop(); });

describe('online now', () => {
  it('opening the app makes the user online; closing it makes them offline at once, with a fresh "last active"', async () => {
    const admin = await adminToken(app, await makeAdmin(db, 'editor'));
    const cms = track(await mustConnect(pod.url, '/admin', { token: admin }));
    const rec = recorder(cms, 'users:presence');
    expect((await emit(cms, 'subscribe', { channels: ['users'] })).ok).toBe(true);
    const a = await account(app);
    await db.query(`UPDATE users SET last_active_at = now() - interval '3 days' WHERE id = $1`, [a.me.id]);

    const phone = await live(a.accessToken);
    const [up] = await rec.wait('users:presence', 1, (p) => p.id === a.me.id && p.online);
    expect(up).toMatchObject({ id: a.me.id, online: true });
    const list = await http(app).get('/v1/admin/users?tab=all', { token: admin });
    expect(list.body.data.find((u: { id: string }) => u.id === a.me.id).online).toBe(true);
    expect(list.body.meta.counts.online).toBe(1);
    expect((await http(app).get(`/v1/admin/users/${a.me.id}`, { token: admin })).body.data.online).toBe(true);

    // a second phone of the same user: still one person online; closing one of them does not make them offline
    const tablet = await live(a.accessToken);
    expect(await online.total()).toBe(1);
    tablet.close();
    await sleep(300);
    expect((await online.isOnline([a.me.id])).has(a.me.id)).toBe(true);
    expect(rec.of('users:presence').filter((p) => !p.online)).toHaveLength(0);

    phone.close();
    const [down] = await rec.wait('users:presence', 1, (p) => p.id === a.me.id && !p.online);
    expect(Date.now() - Date.parse(down.lastActiveAt)).toBeLessThan(10_000);
    const after = (await http(app).get(`/v1/admin/users/${a.me.id}`, { token: admin })).body.data;
    expect(after.online).toBe(false);
    expect(Date.now() - Date.parse(after.lastActiveAt)).toBeLessThan(10_000); // not "3 days ago" any more
  });

  it('"Online now" tab lists only people with the app open; guests count too', async () => {
    const admin = await adminToken(app, await makeAdmin(db, 'owner'));
    const on = await account(app), off = await account(app), g = await guest(app);
    await live(on.accessToken); await live(g.accessToken);
    await waitFor(async () => (await online.total()) === 2);
    const r = await http(app).get('/v1/admin/users?tab=online', { token: admin });
    expect(r.status).toBe(200);
    const ids = r.body.data.map((u: { id: string }) => u.id);
    expect(ids.sort()).toEqual([on.me.id, g.me.id].sort());
    expect(ids).not.toContain(off.me.id);
    expect(r.body.data.every((u: { online: boolean }) => u.online)).toBe(true);
    for (const s of sockets) s.close();
    await waitFor(async () => (await online.total()) === 0);
    expect((await http(app).get('/v1/admin/users?tab=online', { token: admin })).body.data).toEqual([]);
  });

  it('dashboard: online total, guests and countries (a hidden country counts but is never shown), live over the socket', async () => {
    const de1 = await account(app), de2 = await guest(app), us = await account(app), hidden = await account(app);
    await setCountry(de1.me.id, 'DE'); await setCountry(de2.me.id, 'DE'); await setCountry(us.me.id, 'US'); await setCountry(hidden.me.id, 'FR', false);
    for (const u of [de1, de2, us, hidden]) await live(u.accessToken);
    await waitFor(async () => (await online.total()) === 4);
    const owner = track(await mustConnect(pod.url, '/admin', { token: await adminToken(app, await makeAdmin(db, 'owner')) }));
    const rec = recorder(owner, 'dashboard:kpis');
    await emit(owner, 'subscribe', { channels: ['dashboard'] });
    await app.get(RealtimeTicker).kpiTick();
    const [k] = await rec.wait('dashboard:kpis', 1, (p) => p.onlineNow === 4);
    expect(k.onlineGuests).toBe(1);
    expect(k.onlineCountries).toEqual([{ c: 'DE', n: 2 }, { c: 'US', n: 1 }]); // FR is hidden: never listed
  });

  it('an app that vanished without closing its socket is swept after 90 s and the CMS hears it', async () => {
    const admin = await adminToken(app, await makeAdmin(db, 'editor'));
    const cms = track(await mustConnect(pod.url, '/admin', { token: admin }));
    const rec = recorder(cms, 'users:presence');
    await emit(cms, 'subscribe', { channels: ['users'] });
    const ghost = await guest(app);
    await db.query(`UPDATE users SET last_active_at = now() - interval '3 days' WHERE id = $1`, [ghost.me.id]);
    await online.touch({ id: ghost.me.id, isGuest: true, country: null }, ['dead-socket'], Date.now() - ONLINE_STALE_MS - 1000); // a pod died long ago
    expect((await online.isOnline([ghost.me.id])).size).toBe(0); // stale already reads as offline
    await app.get(RealtimeTicker).presenceTick();
    const [off] = await rec.wait('users:presence', 1, (p) => p.id === ghost.me.id && !p.online);
    expect(Date.now() - Date.parse(off.lastActiveAt)).toBeGreaterThan(ONLINE_STALE_MS); // last active = its last sign of life
    expect(await redis.zscore(K.onlineZ, ghost.me.id)).toBeNull();
    const [{ last_active_at }] = (await db.query('SELECT last_active_at FROM users WHERE id = $1', [ghost.me.id])).rows;
    expect(Math.abs(new Date(last_active_at).getTime() - Date.parse(off.lastActiveAt))).toBeLessThan(1000);
  });

  it('two API pods: closing the app on one while it is still open on the other keeps the user online (no flap)', async () => {
    const podB = await startPod();
    try {
      const admin = await adminToken(app, await makeAdmin(db, 'editor'));
      const cms = track(await mustConnect(pod.url, '/admin', { token: admin }));
      const rec = recorder(cms, 'users:presence');
      await emit(cms, 'subscribe', { channels: ['users'] });
      const a = await account(app);
      const phone = await live(a.accessToken, pod.url);
      await rec.wait('users:presence', 1, (p) => p.id === a.me.id && p.online);
      const tablet = await live(a.accessToken, podB.url);
      phone.close();
      await sleep(600);
      expect((await online.isOnline([a.me.id])).has(a.me.id)).toBe(true);
      expect(rec.of('users:presence').filter((p) => p.id === a.me.id && !p.online)).toHaveLength(0);
      expect(rec.of('users:presence').filter((p) => p.id === a.me.id && p.online)).toHaveLength(1); // one "online", not two
      tablet.close();
      await rec.wait('users:presence', 1, (p) => p.id === a.me.id && !p.online);
      expect((await online.isOnline([a.me.id])).size).toBe(0);
    } finally { await podB.stop(); }
  });

  it('a quick reconnect (new socket before the old one is gone) never leaves a connected user offline', async () => {
    const a = await account(app);
    const old = await live(a.accessToken);
    await waitFor(async () => (await online.total()) === 1);
    const fresh = await live(a.accessToken);
    old.close();
    await sleep(500);
    expect((await online.isOnline([a.me.id])).has(a.me.id)).toBe(true);
    fresh.close();
    await waitFor(async () => (await online.total()) === 0);
  });

  it('hiding the country takes the user off that country on the map at once', async () => {
    const a = await account(app);
    await setCountry(a.me.id, 'JP');
    await live(a.accessToken);
    await waitFor(async () => (await online.counts()).countries.some((c) => c.c === 'JP'));
    expect((await http(app).patch('/v1/me', { showCountry: false }, { token: a.accessToken })).status).toBe(200);
    const after = await online.counts();
    expect(after.total).toBe(1); // still counted…
    expect(after.countries).toEqual([]); // …but on no country
  });

  it('cities: the app sends a city, the server rounds the position to ~10 km, the CMS gets online and meditating cities live; hiding the country hides the city', async () => {
    const [a, b, c, h] = [await account(app), await account(app), await account(app), await account(app)];
    for (const [u, country] of [[a, 'PK'], [b, 'PK'], [c, 'DE'], [h, 'FR']] as const) await setCountry(u.me.id, country);
    // a bad city is refused; a good one is rounded (31.5204 -> 31.5), never stored at full precision
    expect((await http(app).patch('/v1/me', { city: { name: '', lat: 1, lng: 1 } }, { token: a.accessToken })).status).toBe(400);
    expect((await http(app).patch('/v1/me', { city: { name: 'Lahore', lat: 91, lng: 1 } }, { token: a.accessToken })).status).toBe(400);
    const set = (u: typeof a, name: string, lat: number, lng: number) => http(app).patch('/v1/me', { city: { name, lat, lng } }, { token: u.accessToken });
    expect((await set(a, 'Lahore', 31.5204, 74.3587)).status).toBe(200);
    await set(b, 'Lahore', 31.5401, 74.4099); await set(c, 'Berlin', 52.5200, 13.4050); await set(h, 'Paris', 48.8566, 2.3522);
    expect((await db.query('SELECT city, city_lat, city_lng FROM users WHERE id = $1', [a.me.id])).rows[0]).toEqual({ city: 'Lahore', city_lat: 31.5, city_lng: 74.4 });
    await http(app).patch('/v1/me', { showCountry: false }, { token: h.accessToken }); // Paris: hidden with the country

    for (const u of [a, b, c, h]) await live(u.accessToken);
    await waitFor(async () => (await online.total()) === 4);
    const sid = uuid(), sA = await live(a.accessToken);
    await emit(sA, 'presence:start', { meditationId: uuid(), sessionId: sid, kind: 'motd', lengthMin: 30, mode: 'solo' });

    const owner = track(await mustConnect(pod.url, '/admin', { token: await adminToken(app, await makeAdmin(db, 'owner')) }));
    const rec = recorder(owner, 'dashboard:kpis');
    await emit(owner, 'subscribe', { channels: ['dashboard'] });
    await app.get(RealtimeTicker).kpiTick();
    const [k] = await rec.wait('dashboard:kpis', 1, (p) => (p.onlineCities ?? []).length > 0);
    expect(k.onlineCities).toEqual([{ c: 'PK', name: 'Lahore', lat: 31.5, lng: 74.4, n: 2 }, { c: 'DE', name: 'Berlin', lat: 52.5, lng: 13.4, n: 1 }]);
    expect(k.meditatingCities).toEqual([{ c: 'PK', name: 'Lahore', lat: 31.5, lng: 74.4, n: 1 }]);

    // leaving removes the city at once; a person with the app closed is on no city
    for (const s of sockets) s.close();
    await waitFor(async () => (await online.total()) === 0);
    expect((await online.cities()).online).toEqual([]);
    // clearing the city (null) takes it off even while online
    const again = await live(a.accessToken);
    await waitFor(async () => (await online.cities()).online.length === 1);
    expect((await http(app).patch('/v1/me', { city: null }, { token: a.accessToken })).status).toBe(200);
    expect((await online.cities()).online).toEqual([]);
    again.close();
  });

  it('only content roles may watch who is online', async () => {
    const mod = track(await mustConnect(pod.url, '/admin', { token: await adminToken(app, await makeAdmin(db, 'moderator')) }));
    expect((await emit<{ denied?: string[] }>(mod, 'subscribe', { channels: ['users'] })).data!.denied).toEqual(['users']);
  });
});
