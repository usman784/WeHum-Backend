import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type Redis from 'ioredis';
import { Client } from 'pg';
import type { Socket } from 'socket.io-client';
import { v7 as uuid } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDIS, K } from '../src/infra/redis';
import { WorkerRunner } from '../src/jobs/workers';
import { TokensService } from '../src/modules/auth/tokens.service';
import { GroupStartService } from '../src/realtime/group-start.service';
import { MAX_ROOMS } from '../src/realtime/live.gateway';
import { PresenceService } from '../src/realtime/presence.service';
import { RealtimeTicker } from '../src/realtime/ticker';
import { adminToken, clearRates, guest, http, makeAdmin, member, resetTestDb } from './helpers';
import { connect, connectRecorded, emit, mustConnect, recorder, sleep, startPod, waitFor } from './realtime-helpers';

let pod: Awaited<ReturnType<typeof startPod>>;
let app: NestFastifyApplication;
let db: Client;
let redis: Redis;
let ticker: RealtimeTicker;
let sockets: Socket[] = [];
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const dayIso = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const track = <T extends Socket>(s: T) => { sockets.push(s); return s; };
const live = async (token: string, extra: Record<string, unknown> = {}, url = pod.url) => track(await mustConnect(url, '/live', { token, ...extra }));
const adminSock = async (token: string, url = pod.url) => track(await mustConnect(url, '/admin', { token }));
const setConfig = async (key: string, patch: Record<string, unknown>) => { await q(`UPDATE app_config SET value = value || $2::jsonb, version = version + 1 WHERE key=$1`, [key, JSON.stringify(patch)]); await redis.del(K.config(key), ...(await redis.keys('motd:*')), ...(await redis.keys('today:*'))); };

beforeAll(async () => {
  await resetTestDb();
  pod = await startPod();
  app = pod.app;
  redis = app.get(REDIS); ticker = app.get(RealtimeTicker);
  app.get(WorkerRunner).start();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
beforeEach(async () => {
  await clearRates();
  const keys = [...await redis.keys('pz:*'), ...await redis.keys('lobby:*'), ...await redis.keys('edit:*'), ...await redis.keys('live:*'), ...await redis.keys('dash:*'), ...await redis.keys('group:started:*')];
  if (keys.length) await redis.del(...keys);
  (ticker as any).lastAgg = ''; (ticker as any).lastSession.clear(); (ticker as any).lastLobby.clear(); (ticker as any).lastMotd.clear(); (ticker as any).lastKpis = ''; // eslint-disable-line @typescript-eslint/no-explicit-any
});
afterEach(async () => { for (const s of sockets) s.close(); sockets = []; await sleep(20); });
afterAll(async () => { await db?.end(); await pod?.stop(); });

describe('P5 /live handshake', () => {
  it('needs a valid access token; failures tell the app what to do', async () => {
    const g = await guest(app);
    const expectCode = async (auth: Record<string, unknown> | undefined, code: string) => { const r = await connect(pod.url, '/live', auth); sockets.push(r.socket); expect(r.error?.code, JSON.stringify(auth)?.slice(0, 40)).toBe(code); expect(r.error?.message).toBe(code); };
    await expectCode(undefined, 'AUTH_REQUIRED');
    await expectCode({}, 'AUTH_REQUIRED');
    await expectCode({ token: 'not-a-jwt' }, 'TOKEN_INVALID');
    await expectCode({ token: g.accessToken.slice(0, -3) + 'abc' }, 'TOKEN_INVALID'); // forged signature
    const short = await app.get(TokensService).tokenFor(g.me.id, 1);
    await sleep(1400);
    await expectCode({ token: short }, 'TOKEN_EXPIRED'); // the app refreshes and reconnects
    const admin = await makeAdmin(db, 'owner');
    await expectCode({ token: await adminToken(app, admin) }, 'TOKEN_INVALID'); // a CMS token is not an app token
    const ok = await connect(pod.url, '/live', { token: g.accessToken, installId: 'install-1', appVersion: '1.0.0' });
    sockets.push(ok.socket);
    expect(ok.error).toBeUndefined();
    expect(ok.socket.connected).toBe(true);
  });

  it('refuses revoked tokens, deleted users and apps that must update', async () => {
    const g = await guest(app), gone = await guest(app), old = await guest(app);
    await app.get(TokensService).bumpTokenVersion(g.me.id);
    expect((await connect(pod.url, '/live', { token: g.accessToken })).error?.code).toBe('TOKEN_INVALID');
    await q(`UPDATE users SET deleted_at = now() WHERE id=$1`, [gone.me.id]);
    expect((await connect(pod.url, '/live', { token: gone.accessToken })).error?.code).toBe('GONE');
    await setConfig('main', { minVersion: { ios: '2.0.0', android: '1.0.0' } });
    expect((await connect(pod.url, '/live', { token: old.accessToken, appVersion: '1.9.0', platform: 'ios' })).error?.code).toBe('UPDATE_REQUIRED');
    const fine = await connect(pod.url, '/live', { token: old.accessToken, appVersion: '2.0.0', platform: 'ios' }); sockets.push(fine.socket);
    expect(fine.error).toBeUndefined();
    const android = await connect(pod.url, '/live', { token: old.accessToken, appVersion: '1.0.0', platform: 'android' }); sockets.push(android.socket);
    expect(android.error).toBeUndefined();
    await setConfig('main', { minVersion: { ios: '1.0.0', android: '1.0.0' } });
  });

  it('is websocket only', async () => {
    const g = await guest(app);
    const { io } = await import('socket.io-client');
    const poll = io(`${pod.url}/live`, { transports: ['polling'], auth: { token: g.accessToken }, reconnection: false, forceNew: true });
    sockets.push(poll);
    const err = await new Promise<Error>((res) => { poll.on('connect_error', res); poll.on('connect', () => res(new Error('connected over polling'))); });
    expect(err.message).not.toBe('connected over polling');
  });

  it('joins the personal room and `config`, and answers time:sync', async () => {
    const g = await guest(app);
    const s = await live(g.accessToken);
    const rec = recorder(s, 'config:changed', 'catalog:changed');
    const t0 = Date.now();
    const r = await emit<{ t0: number; serverTime: number }>(s, 'time:sync', { t0 });
    expect(r).toMatchObject({ ok: true, data: { t0 } });
    expect(Math.abs(r.data!.serverTime - Date.now())).toBeLessThan(1500);
    expect((await emit(s, 'time:sync', { t0: 'x' })).code).toBe('VALIDATION_FAILED');
    expect((await emit(s, 'time:sync', {})).code).toBe('VALIDATION_FAILED');
    // `config` room: a config change reaches the app
    await pod.app.get(REDIS).publish('events', JSON.stringify({ topic: 'config:changed', payload: { key: 'today', version: 7 } }));
    expect((await rec.wait('config:changed'))[0]).toEqual({ key: 'today', version: 7 });
  });
});

describe('P5 token expiry while connected', () => {
  it('auth:expiring ahead of time; refreshing keeps the socket, otherwise TOKEN_EXPIRED + disconnect', async () => {
    const g = await guest(app);
    const short = await app.get(TokensService).tokenFor(g.me.id, 3); // < 60 s left → the warning comes at once
    const { socket: s, rec } = await connectRecorded(pod.url, '/live', { token: short }, 'auth:expiring', 'error');
    track(s);
    const [warn] = await rec.wait('auth:expiring');
    expect(warn.exp).toBeGreaterThan(Date.now() / 1000);
    const fresh = await app.get(TokensService).tokenFor(g.me.id);
    const r = await emit<{ exp: number }>(s, 'auth:refresh', { token: fresh });
    expect(r.ok).toBe(true);
    await sleep(3600); // the old token would have expired by now
    expect(s.connected).toBe(true);
    expect(rec.of('error')).toEqual([]);

    const other = await guest(app);
    expect((await emit(s, 'auth:refresh', { token: await app.get(TokensService).tokenFor(other.me.id) })).code).toBe('TOKEN_INVALID'); // not my token
    expect((await emit(s, 'auth:refresh', { token: 'x'.repeat(30) })).ok).toBe(false);
    expect((await emit(s, 'auth:refresh', {})).code).toBe('VALIDATION_FAILED');
  });

  it('no refresh → the server ends the connection when the token ends', async () => {
    const g = await guest(app);
    const s = await live(await app.get(TokensService).tokenFor(g.me.id, 2));
    const rec = recorder(s, 'error');
    const reason = await new Promise<string>((res) => s.on('disconnect', res));
    expect(reason).toBe('io server disconnect');
    expect(rec.of('error')).toEqual([{ code: 'TOKEN_EXPIRED' }]);
  });
});

describe('P5 rooms', () => {
  it('only known room names; the screen gets the current state right after joining', async () => {
    const g = await guest(app);
    const s = await live(g.accessToken);
    const rec = recorder(s, 'live:agg', 'session:live', 'motd:stats');
    const sid = uuid();
    for (const bad of ['', 'foo', 'today ', 'World', 'session:xyz', `session:${sid}x`, 'motd:2026-13-01', 'lobbyx:2026-10-05', 'motd:today', 'user:abc', 'config', 'admin:1']) {
      expect((await emit(s, 'room:join', { room: bad })).code, bad).toBe('VALIDATION_FAILED');
    }
    expect((await emit(s, 'room:join', {})).code).toBe('VALIDATION_FAILED');
    expect((await emit(s, 'room:join', { room: 'today', extra: 1 })).code).toBe('VALIDATION_FAILED');
    await redis.hset(K.aggCountry, { DE: 3, US: 1 });
    expect(await emit(s, 'room:join', { room: 'today' })).toEqual({ ok: true, data: { joined: 'today' } });
    expect((await rec.wait('live:agg'))[0]).toMatchObject({ total: 4, countries: 2, top: [{ c: 'DE', n: 3 }, { c: 'US', n: 1 }] });
    await app.get(PresenceService).start({ meditationId: uuid(), userId: uuid(), sessionId: sid, country: 'FR', mode: 'solo' });
    await emit(s, 'room:join', { room: `session:${sid}` });
    expect((await rec.wait('session:live'))[0]).toEqual({ sessionId: sid, people: 1, countries: 1 });
    await redis.sadd(K.practiced(dayIso()), 'a', 'b');
    await emit(s, 'room:join', { room: `motd:${dayIso()}` });
    expect((await rec.wait('motd:stats'))[0]).toEqual({ date: dayIso(), practicedToday: 2 });
    await redis.del(K.aggCountry, K.practiced(dayIso()));
  });

  it('at most 4 rooms; leaving frees a slot; joining twice is harmless', async () => {
    const g = await guest(app);
    const s = await live(g.accessToken);
    expect(MAX_ROOMS).toBe(4);
    const rooms = ['today', 'world', `motd:${dayIso()}`, `session:${uuid()}`];
    for (const room of rooms) expect((await emit(s, 'room:join', { room })).ok).toBe(true);
    expect(await emit(s, 'room:join', { room: `session:${uuid()}` })).toMatchObject({ ok: false, code: 'ROOM_LIMIT' });
    expect((await emit(s, 'room:join', { room: 'today' })).ok).toBe(true); // already in: not a new room
    expect((await emit(s, 'room:leave', { room: 'world' })).ok).toBe(true);
    expect((await emit(s, 'room:join', { room: `session:${uuid()}` })).ok).toBe(true);
    expect((await emit(s, 'room:leave', { room: 'never-joined' })).ok).toBe(true);
  });

  it('only joined rooms receive their events', async () => {
    const [a, b] = await Promise.all([guest(app), guest(app)]);
    const sa = await live(a.accessToken), sb = await live(b.accessToken);
    const ra = recorder(sa, 'live:agg'), rb = recorder(sb, 'live:agg');
    await emit(sa, 'room:join', { room: 'world' });
    await emit(sb, 'room:join', { room: `motd:${dayIso()}` }); // not a live-numbers room
    ra.clear(); rb.clear();
    await app.get(PresenceService).start({ meditationId: uuid(), userId: uuid(), country: 'JP', mode: 'solo' });
    await ticker.presenceTick();
    await ra.wait('live:agg');
    await sleep(150);
    expect(rb.of('live:agg')).toEqual([]);
    await emit(sa, 'room:leave', { room: 'world' });
    ra.clear();
    await app.get(PresenceService).start({ meditationId: uuid(), userId: uuid(), country: 'KR', mode: 'solo' });
    await ticker.presenceTick(); await sleep(150);
    expect(ra.of('live:agg')).toEqual([]); // left the room
  });
});

describe('P5 presence over the socket', () => {
  it('start → the world sees it at the next tick; beat; stop; the ack tells the app how many are together', async () => {
    const [a, b, watcher] = await Promise.all([guest(app), guest(app), guest(app)]);
    await q(`UPDATE users SET country='DE' WHERE id=$1`, [a.me.id]); await q(`UPDATE users SET country='US' WHERE id=$1`, [b.me.id]);
    const sa = await live(a.accessToken), sb = await live(b.accessToken), sw = await live(watcher.accessToken);
    const world = recorder(sw, 'live:agg', 'session:live');
    const sid = uuid();
    await emit(sw, 'room:join', { room: 'world' }); await emit(sw, 'room:join', { room: `session:${sid}` });
    world.clear();
    const m1 = uuid(), m2 = uuid();
    const r1 = await emit(sa, 'presence:start', { meditationId: m1, sessionId: sid, kind: 'motd', lengthMin: 30, mode: 'solo' });
    expect(r1).toEqual({ ok: true, data: { together: { people: 1, countries: 1 } } });
    const r2 = await emit(sb, 'presence:start', { meditationId: m2, sessionId: sid, kind: 'motd', mode: 'group' });
    expect(r2.data).toEqual({ together: { people: 2, countries: 2 } });
    await ticker.presenceTick();
    expect((await world.wait('live:agg', 1, (p) => p.total === 2))[0]).toMatchObject({ total: 2, countries: 2, top: [{ c: 'DE', n: 1 }, { c: 'US', n: 1 }], quiet: true });
    expect((await world.wait('session:live', 1, (p) => p.people === 2))[0]).toEqual({ sessionId: sid, people: 2, countries: 2 });
    expect(await emit(sa, 'presence:beat', { meditationId: m1 })).toEqual({ ok: true, data: {} });
    expect((await emit(sa, 'presence:beat', { meditationId: uuid() })).code).toBe('NOT_FOUND'); // expired: the app starts it again
    expect(await emit(sa, 'presence:stop', { meditationId: m1 })).toMatchObject({ ok: true });
    await ticker.presenceTick();
    expect((await world.wait('live:agg', 1, (p) => p.total === 1))[0]).toMatchObject({ total: 1, countries: 1 });
    expect(await emit(sb, 'presence:stop', { meditationId: m2 })).toMatchObject({ ok: true });
    await ticker.presenceTick();
    await world.wait('live:agg', 1, (p) => p.total === 0);
    await world.wait('session:live', 1, (p) => p.people === 0);
  });

  it('nobody can beat, stop or take over someone else’s meditation; bad payloads are refused', async () => {
    const [a, b] = await Promise.all([guest(app), guest(app)]);
    const sa = await live(a.accessToken), sb = await live(b.accessToken);
    const id = uuid();
    await emit(sa, 'presence:start', { meditationId: id, kind: 'solo', mode: 'solo' });
    expect((await emit(sb, 'presence:start', { meditationId: id, kind: 'solo', mode: 'solo' })).code).toBe('FORBIDDEN');
    expect((await emit(sb, 'presence:beat', { meditationId: id })).code).toBe('NOT_FOUND');
    await emit(sb, 'presence:stop', { meditationId: id });
    expect(await redis.exists(K.presenceMed(id))).toBe(1); // still there
    for (const bad of [{}, { meditationId: 'x', kind: 'solo', mode: 'solo' }, { meditationId: uuid(), kind: 'nap', mode: 'solo' }, { meditationId: uuid(), kind: 'solo', mode: 'duo' }, { meditationId: uuid(), kind: 'solo', mode: 'solo', country: 'US' }, { meditationId: uuid(), kind: 'solo', mode: 'solo', lengthMin: 0 }]) {
      expect((await emit(sa, 'presence:start', bad)).code, JSON.stringify(bad)).toBe('VALIDATION_FAILED');
    }
    expect((await emit(sa, 'presence:beat', { meditationId: 'nope' })).code).toBe('VALIDATION_FAILED');
  });

  it('the app’s country comes from its profile; “show my country” off hides it', async () => {
    const [a, b] = await Promise.all([guest(app), guest(app)]);
    await q(`UPDATE users SET country='FR', show_country=true WHERE id=$1`, [a.me.id]); await q(`UPDATE users SET country='FR', show_country=false WHERE id=$1`, [b.me.id]);
    const sa = await live(a.accessToken), sb = await live(b.accessToken);
    await emit(sa, 'presence:start', { meditationId: uuid(), kind: 'solo', mode: 'solo' });
    const r = await emit(sb, 'presence:start', { meditationId: uuid(), kind: 'solo', mode: 'solo' });
    expect(r.data).toEqual({ together: { people: 2, countries: 1 } }); // the hidden one is a person, not a country
    const snap = (await http(app).get('/v1/live', { token: a.accessToken })).body.data;
    expect(snap).toMatchObject({ total: 2, countries: 1, top: [{ c: 'FR', n: 1 }] });
  });

  it('disconnecting keeps presence for 90 s (a backgrounded app can come back), expiry removes it', async () => {
    const a = await guest(app);
    const s = await live(a.accessToken);
    const id = uuid();
    await emit(s, 'presence:start', { meditationId: id, kind: 'solo', mode: 'solo' });
    s.close();
    await sleep(100);
    expect(await redis.exists(K.presenceMed(id))).toBe(1);
    const back = await live(a.accessToken);
    expect(await emit(back, 'presence:beat', { meditationId: id })).toMatchObject({ ok: true }); // the new connection can keep it alive
    await redis.zadd(K.presenceZ, Date.now() - 100_000, id);
    await ticker.presenceTick();
    expect(await redis.exists(K.presenceMed(id))).toBe(0);
    expect((await emit(back, 'presence:beat', { meditationId: id })).code).toBe('NOT_FOUND');
  });
});

describe('P5 lobby + group start', () => {
  it('the group meditation is members-only; the lobby shows who is waiting', async () => {
    const free = await guest(app), m1 = await member(app, db), m2 = await member(app, db);
    await q(`UPDATE users SET country='DE' WHERE id=$1`, [m1.me.id]); await q(`UPDATE users SET country='JP' WHERE id=$1`, [m2.me.id]);
    const date = dayIso();
    const sf = await live(free.accessToken);
    expect(await emit(sf, 'lobby:join', { date })).toMatchObject({ ok: false, code: 'PREMIUM_REQUIRED' });
    expect((await emit(sf, 'room:join', { room: `lobby:${date}` })).code).toBe('PREMIUM_REQUIRED');
    const s1 = await live(m1.accessToken), s2 = await live(m2.accessToken);
    const r1 = recorder(s1, 'lobby:state');
    const first = await emit<{ startsAt: string; waiting: number }>(s1, 'lobby:join', { date });
    expect(first).toEqual({ ok: true, data: { startsAt: `${date}T16:00:00.000Z`, waiting: 1 } });
    expect((await r1.wait('lobby:state'))[0]).toMatchObject({ date, waiting: 1, countries: 1 }); // the state arrives with the join
    expect((await emit(s2, 'lobby:join', { date })).data!.waiting).toBe(2);
    await ticker.lobbyTick();
    expect((await r1.wait('lobby:state', 1, (p) => p.waiting === 2))[0]).toMatchObject({ waiting: 2, countries: 2, regions: [{ r: 'Asia', n: 1 }, { r: 'Europe', n: 1 }] });
    expect((await emit(s1, 'lobby:join', { date: dayIso(5) })).code).toBe('VALIDATION_FAILED'); // not a date you can wait for
    expect((await emit(s1, 'lobby:join', { date: 'tomorrow' })).code).toBe('VALIDATION_FAILED');
    expect((await emit(s2, 'lobby:leave', { date })).ok).toBe(true);
    await ticker.lobbyTick();
    await r1.wait('lobby:state', 1, (p) => p.waiting === 1);
    s1.close(); await sleep(150);
    expect(await redis.zcard(K.lobby(date))).toBe(0); // disconnecting leaves the lobby at once
  });

  it('lobby members stay fresh while connected (the pod refreshes them)', async () => {
    const m = await member(app, db);
    const s = await live(m.accessToken);
    const date = dayIso();
    await emit(s, 'lobby:join', { date });
    await redis.zadd(K.lobby(date), Date.now() - 80_000, m.me.id); // about to go stale
    const { LiveGateway } = await import('../src/realtime/live.gateway');
    await (app.get(LiveGateway) as unknown as { touchLobbies: () => Promise<void> }).touchLobbies();
    expect(Number(await redis.zscore(K.lobby(date), m.me.id))).toBeGreaterThan(Date.now() - 2000);
  });

  it('T0: every client in the lobby gets group:start within a second (100 clients, real delayed job)', async () => {
    const N = 100;
    const date = dayIso();
    const now = Date.now();
    let t0 = Math.ceil((now + 9000) / 60_000) * 60_000; // the next whole minute that is at least 9 s away
    if (t0 - now > 66_000) t0 -= 60_000;
    await setConfig('group', { startUtc: new Date(t0).toISOString().slice(11, 16), lobbyOpenMin: 15 });
    // t0 may fall on tomorrow's date when run just before midnight UTC; the lobby date is the date of T0
    const lobbyDate = new Date(t0).toISOString().slice(0, 10);
    const users = await Promise.all(Array.from({ length: N }, () => member(app, db)));
    const socks = await Promise.all(users.map((u) => live(u.accessToken)));
    const recs = socks.map((s) => recorder(s, 'group:start', 'lobby:state'));
    for (const s of socks) expect((await emit(s, 'lobby:join', { date: lobbyDate })).ok).toBe(true);
    await q(`UPDATE motd_days SET group_joined = 0 WHERE date=$1`, [lobbyDate]);
    const queued = await app.get(GroupStartService).schedule(Date.now());
    expect(queued.length).toBeGreaterThanOrEqual(1);
    await Promise.all(recs.map((r) => r.wait('group:start', 1, undefined, t0 - Date.now() + 5000)));
    const delays = recs.map((r) => r.all().find((e) => e.event === 'group:start')!.at - t0);
    delays.sort((x, y) => x - y);
    const stat = { min: delays[0], p50: delays[Math.floor(N / 2)], p95: delays[Math.floor(N * 0.95)], max: delays[N - 1] };
    console.log('P5 group:start delay after T0 (ms)', JSON.stringify(stat));
    expect(stat.min!).toBeGreaterThanOrEqual(-10); // never early (client and server share a clock here)
    expect(stat.p95!).toBeLessThan(50); // ±50 ms, as the spec asks
    expect(stat.max!).toBeLessThan(1000); // spec: all clients receive < 1 s
    const payload = recs[0]!.of('group:start')[0];
    expect(payload).toMatchObject({ date: lobbyDate, startsAt: new Date(t0).toISOString(), lengthMin: 30, mediaKey: `motd:${lobbyDate}:30` });
    expect(recs.every((r) => r.of('group:start').length === 1)).toBe(true); // exactly once each
    const joined = (await q<{ group_joined: number }>(`SELECT group_joined FROM motd_days WHERE date=$1`, [lobbyDate]))[0]?.group_joined;
    if (joined !== undefined) expect(joined).toBe(N);
    await setConfig('group', { startUtc: '16:00' });
  }, 120_000);
});

describe('P5 events after commit (outbox → Redis → sockets)', () => {
  it('an admin edit reaches the CMS as entity:changed and the app as catalog:changed', async () => {
    const editor = await makeAdmin(db, 'editor'), observer = await makeAdmin(db, 'admin');
    const et = await adminToken(app, editor), ot = await adminToken(app, observer);
    const cms = await adminSock(ot);
    const appSock = await live((await guest(app)).accessToken);
    const cmsRec = recorder(cms, 'entity:changed'), appRec = recorder(appSock, 'catalog:changed', 'config:changed');
    const t = await http(app).post('/v1/admin/themes', { name: 'Realtime Theme' }, { token: et });
    expect(t.status).toBe(201);
    const [created] = await cmsRec.wait('entity:changed', 1, (p) => p.id === t.body.data.id);
    expect(created).toEqual({ type: 'theme', id: t.body.data.id, op: 'create', version: 1, by: { id: editor.id, name: 'Test editor' } });
    const [cat] = await appRec.wait('catalog:changed');
    expect(cat.version).toBeGreaterThan(1);
    await http(app).patch(`/v1/admin/themes/${t.body.data.id}`, { subtitle: 'x' }, { token: et });
    expect((await cmsRec.wait('entity:changed', 1, (p) => p.id === t.body.data.id && p.op === 'update'))[0]).toMatchObject({ version: 2 });
    await http(app).del(`/v1/admin/themes/${t.body.data.id}`, { token: et });
    expect((await cmsRec.wait('entity:changed', 1, (p) => p.id === t.body.data.id && p.op === 'delete'))[0]).toMatchObject({ type: 'theme' });
    // a config change goes to both
    const cfg = await http(app).get('/v1/admin/config/today', { token: et });
    await http(app).put('/v1/admin/config/today', { ...cfg.body.data.value, emptyRoomThreshold: 11 }, { token: et });
    expect((await appRec.wait('config:changed', 1, (p) => p.key === 'today'))[0]).toMatchObject({ key: 'today' });
    expect((await cmsRec.wait('entity:changed', 1, (p) => p.type === 'config' && p.id === 'today'))[0]).toMatchObject({ op: 'update' });
    await http(app).put('/v1/admin/config/today', { ...cfg.body.data.value, emptyRoomThreshold: 10 }, { token: et });
  });

  it('a rolled-back write never produces an event; a committed one produces exactly one', async () => {
    const admin = await makeAdmin(db, 'admin');
    const cms = await adminSock(await adminToken(app, admin));
    const rec = recorder(cms, 'entity:changed');
    const ghost = uuid(), real = uuid();
    const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    await c.query('BEGIN');
    await c.query(`INSERT INTO outbox_events (topic, payload) VALUES ('entity:changed', $1)`, [JSON.stringify({ type: 'theme', id: ghost, action: 'theme.update', version: 9, by: null })]);
    await sleep(500); // long enough for several relay polls
    await c.query('ROLLBACK');
    await c.query(`INSERT INTO outbox_events (topic, payload) VALUES ('entity:changed', $1)`, [JSON.stringify({ type: 'theme', id: real, action: 'theme.update', version: 3, by: null })]);
    await c.end();
    await rec.wait('entity:changed', 1, (p) => p.id === real);
    await sleep(500);
    expect(rec.of('entity:changed').filter((p) => p.id === ghost)).toEqual([]);
    expect(rec.of('entity:changed').filter((p) => p.id === real)).toHaveLength(1); // not repeated by later polls
    expect(rec.of('entity:changed').find((p) => p.id === real)).toEqual({ type: 'theme', id: real, op: 'update', version: 3, by: null });
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM outbox_events WHERE published_at IS NULL`))[0]!.n).toBe(0);
    // an admin write that fails inside its transaction leaves no event either
    const before = rec.of('entity:changed').length;
    const ids = (await http(app).get('/v1/admin/themes', { token: await adminToken(app, admin) })).body.data.map((t: { id: string }) => t.id);
    expect((await http(app).put('/v1/admin/themes/order', { ids: ids.slice(1) }, { token: await adminToken(app, admin) })).status).toBe(400);
    await sleep(400);
    expect(rec.of('entity:changed').length).toBe(before);
  });

  it('burst of 300 events: every one arrives, once, in order of commit', async () => {
    const admin = await makeAdmin(db, 'admin');
    const cms = await adminSock(await adminToken(app, admin));
    const rec = recorder(cms, 'entity:changed');
    const tag = uuid();
    const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    for (let i = 0; i < 300; i++) await c.query(`INSERT INTO outbox_events (topic, payload) VALUES ('entity:changed', $1)`, [JSON.stringify({ type: 'theme', id: `${tag}-${i}`, action: 'theme.update', version: i, by: null })]);
    await c.end();
    await rec.wait('entity:changed', 300, (p) => String(p.id).startsWith(tag), 15_000);
    await sleep(300);
    const mine = rec.of('entity:changed').filter((p) => String(p.id).startsWith(tag));
    expect(mine).toHaveLength(300);
    expect(new Set(mine.map((p) => p.id)).size).toBe(300);
    expect(mine.map((p) => p.version)).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });

  it('job progress goes to the jobs channel and to whoever started the job', async () => {
    const creator = await makeAdmin(db, 'editor'), watcher = await makeAdmin(db, 'admin'), stranger = await makeAdmin(db, 'editor');
    const [sc, sw, ss] = await Promise.all([adminSock(await adminToken(app, creator)), adminSock(await adminToken(app, watcher)), adminSock(await adminToken(app, stranger))]);
    expect(await emit(sw, 'subscribe', { channels: ['jobs'] })).toEqual({ ok: true, data: { joined: ['jobs'] } });
    const [rc, rw, rs] = [recorder(sc, 'job:progress'), recorder(sw, 'job:progress'), recorder(ss, 'job:progress')];
    const jobId = uuid();
    await q(`INSERT INTO jobs (id, type, status, progress, payload, created_by) VALUES ($1,'media_transcode','running',40,'{}',$2)`, [jobId, creator.id]);
    await q(`INSERT INTO outbox_events (topic, payload) VALUES ('job:progress', $1)`, [JSON.stringify({ jobId })]);
    expect((await rc.wait('job:progress'))[0]).toEqual({ id: jobId, type: 'media_transcode', status: 'running', progress: 40 }); // the creator, without subscribing
    expect((await rw.wait('job:progress'))[0].id).toBe(jobId); // a subscriber
    await sleep(250);
    expect(rs.of('job:progress')).toEqual([]); // someone else's job
    await q(`UPDATE jobs SET status='failed', error='This is not a valid audio file' WHERE id=$1`, [jobId]);
    await q(`INSERT INTO outbox_events (topic, payload) VALUES ('job:progress', $1)`, [JSON.stringify({ jobId })]);
    expect((await rc.wait('job:progress', 2))[1]).toMatchObject({ status: 'failed', error: 'This is not a valid audio file' });
  });
});

describe('P5 /admin namespace', () => {
  it('handshake: admin tokens only, revoked and disabled admins refused', async () => {
    const a = await makeAdmin(db, 'editor'), g = await guest(app);
    expect((await connect(pod.url, '/admin', undefined)).error?.code).toBe('AUTH_REQUIRED');
    expect((await connect(pod.url, '/admin', { token: g.accessToken })).error?.code).toBe('TOKEN_INVALID'); // an app token
    expect((await connect(pod.url, '/admin', { token: 'x' })).error?.code).toBe('TOKEN_INVALID');
    const t = await adminToken(app, a);
    sockets.push((await connect(pod.url, '/admin', { token: t })).socket);
    await app.get(TokensService).revokeAdminAccess(a.id);
    expect((await connect(pod.url, '/admin', { token: t })).error?.code).toBe('TOKEN_INVALID');
    const b = await makeAdmin(db, 'editor');
    await q(`UPDATE admin_users SET status='disabled' WHERE id=$1`, [b.id]);
    expect((await connect(pod.url, '/admin', { token: await adminToken(app, b) })).error?.code).toBe('TOKEN_INVALID');
    const short = await app.get(TokensService).signAccess({ sub: a.id, role: 'editor', name: 'x', ver: await app.get(TokensService).adminVersion(a.id) }, 'wehum-cms', 1);
    await sleep(1300);
    expect((await connect(pod.url, '/admin', { token: short })).error?.code).toBe('TOKEN_EXPIRED');
  });

  it('subscribe is checked per role', async () => {
    const roles = ['owner', 'admin', 'editor', 'moderator'] as const;
    const socks = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, await adminSock(await adminToken(app, await makeAdmin(db, r)))]))) as Record<(typeof roles)[number], Socket>;
    const all = ['dashboard', 'moderation', 'subscriptions', 'users', 'jobs', 'entity:session:abc', 'entity:theme:1', 'entity:nope:1', 'bogus', 'entity:session:', 'entities'];
    const joined = async (r: (typeof roles)[number]) => (await emit<{ joined: string[]; denied?: string[] }>(socks[r], 'subscribe', { channels: all })).data!.joined;
    expect(await joined('owner')).toEqual(['dashboard', 'moderation', 'subscriptions', 'users', 'jobs', 'entity:session:abc', 'entity:theme:1']);
    expect(await joined('admin')).toEqual(['dashboard', 'moderation', 'subscriptions', 'users', 'jobs', 'entity:session:abc', 'entity:theme:1']);
    expect(await joined('editor')).toEqual(['dashboard', 'subscriptions', 'users', 'jobs', 'entity:session:abc', 'entity:theme:1']); // no moderation
    expect(await joined('moderator')).toEqual(['dashboard', 'moderation', 'jobs']); // no content, subscriptions or users
    const denied = (await emit<{ denied?: string[] }>(socks.moderator, 'subscribe', { channels: ['subscriptions', 'users'] })).data!.denied;
    expect(denied).toEqual(['subscriptions', 'users']);
    expect((await emit(socks.owner, 'subscribe', { channels: [] })).code).toBe('VALIDATION_FAILED');
    expect((await emit(socks.owner, 'subscribe', {})).code).toBe('VALIDATION_FAILED');
    expect((await emit(socks.owner, 'unsubscribe', { channels: ['dashboard'] })).ok).toBe(true);
  });

  it('dashboard: KPIs and live numbers every few seconds; moderators only see the moderation count', async () => {
    const owner = await adminSock(await adminToken(app, await makeAdmin(db, 'owner')));
    const mod = await adminSock(await adminToken(app, await makeAdmin(db, 'moderator')));
    const ro = recorder(owner, 'dashboard:kpis', 'live:agg'), rm = recorder(mod, 'dashboard:kpis', 'live:agg');
    await app.get(PresenceService).start({ meditationId: uuid(), userId: uuid(), country: 'DE', mode: 'solo' });
    await redis.set(K.medsToday(dayIso()), '77');
    await ticker.kpiTick(); // the current numbers exist before anyone subscribes: new subscribers get them at once
    await emit(owner, 'subscribe', { channels: ['dashboard'] }); await emit(mod, 'subscribe', { channels: ['dashboard'] });
    const [first] = await ro.wait('dashboard:kpis');
    expect(first).toMatchObject({ liveNow: 1, meditationsToday: 77, payingMembers: expect.any(Number), founding: { cap: 1000 } });
    expect((await ro.wait('live:agg'))[0].total).toBe(1);
    expect((await rm.wait('dashboard:kpis'))[0]).toEqual({ moderationOpen: expect.any(Number), at: expect.any(Number) });
    expect(rm.of('live:agg')).toEqual([]);
    ro.clear(); rm.clear();
    await redis.set(K.medsToday(dayIso()), '78');
    expect(await ticker.kpiTick()).toBe(true);
    expect((await ro.wait('dashboard:kpis'))[0].meditationsToday).toBe(78);
    expect(Object.keys((await rm.wait('dashboard:kpis'))[0]).sort()).toEqual(['at', 'moderationOpen']);
    await app.get(PresenceService).start({ meditationId: uuid(), userId: uuid(), country: 'US', mode: 'solo' });
    await ticker.presenceTick();
    expect((await ro.wait('live:agg', 1, (p) => p.total === 2))[0]).toMatchObject({ total: 2 });
  });

  it('who is editing what: one entry per admin, updates on stop and on disconnect', async () => {
    const [ann, bob] = [await makeAdmin(db, 'editor'), await makeAdmin(db, 'admin')];
    const [annTab1, annTab2, bobSock, viewer, mod] = await Promise.all([adminSock(await adminToken(app, ann)), adminSock(await adminToken(app, ann)), adminSock(await adminToken(app, bob)), adminSock(await adminToken(app, await makeAdmin(db, 'owner'))), adminSock(await adminToken(app, await makeAdmin(db, 'moderator')))]);
    const sid = uuid();
    const watch = recorder(viewer, 'editing:presence');
    await emit(viewer, 'subscribe', { channels: [`entity:session:${sid}`] });
    expect((await emit(annTab1, 'editing:start', { type: 'session', id: sid })).ok).toBe(true);
    expect((await watch.wait('editing:presence'))[0]).toEqual({ type: 'session', id: sid, admins: [{ id: ann.id, name: 'Test editor' }] });
    await emit(annTab2, 'editing:start', { type: 'session', id: sid }); // same admin, second tab
    await emit(bobSock, 'editing:start', { type: 'session', id: sid });
    const both = await watch.wait('editing:presence', 1, (p) => p.admins.length === 2);
    expect(both[0].admins.map((a: { id: string }) => a.id).sort()).toEqual([ann.id, bob.id].sort()); // Ann once, not twice
    await emit(annTab1, 'editing:stop', { type: 'session', id: sid });
    await sleep(150);
    expect(watch.of('editing:presence').at(-1).admins).toHaveLength(2); // her other tab is still open
    annTab2.close();
    expect((await watch.wait('editing:presence', 1, (p) => p.admins.length === 1 && p.admins[0].id === bob.id))[0].admins[0].id).toBe(bob.id); // closing the tab ends it
    bobSock.close();
    expect((await watch.wait('editing:presence', 1, (p) => p.admins.length === 0))[0]).toEqual({ type: 'session', id: sid, admins: [] });
    expect(await redis.exists(K.editing('session', sid))).toBe(0);
    expect((await emit(mod, 'editing:start', { type: 'session', id: sid })).code).toBe('FORBIDDEN'); // moderators do not edit content
    expect((await emit(annTab1, 'editing:start', { type: 'spaceship', id: sid })).code).toBe('VALIDATION_FAILED');
    expect((await emit(annTab1, 'editing:start', { type: 'session' })).code).toBe('VALIDATION_FAILED');
  });
});

describe('P5 force logout', () => {
  it('an app user whose token version is bumped (password reset, merge) is signed out at once', async () => {
    const g = await guest(app), other = await guest(app);
    const s = await live(g.accessToken), keep = await live(other.accessToken);
    const rec = recorder(s, 'force:logout'), recOther = recorder(keep, 'force:logout');
    const closed = new Promise<string>((res) => s.on('disconnect', res));
    await app.get(TokensService).bumpTokenVersion(g.me.id);
    expect((await rec.wait('force:logout'))[0]).toEqual({ reason: 'signed_out' });
    expect(await closed).toBe('io server disconnect');
    await sleep(300);
    expect(keep.connected).toBe(true);
    expect(recOther.of('force:logout')).toEqual([]);
    expect((await connect(pod.url, '/live', { token: g.accessToken })).error?.code).toBe('TOKEN_INVALID'); // and the old token no longer connects
  });

  it('a CMS admin whose role changes or who is disabled is signed out of the CMS socket', async () => {
    const owner = await makeAdmin(db, 'owner'), editor = await makeAdmin(db, 'editor'), bystander = await makeAdmin(db, 'editor');
    const se = await adminSock(await adminToken(app, editor)), sb = await adminSock(await adminToken(app, bystander));
    const re = recorder(se, 'force:logout'), rb = recorder(sb, 'force:logout');
    const closed = new Promise<string>((res) => se.on('disconnect', res));
    const r = await http(app).patch(`/v1/admin/team/${editor.id}`, { role: 'moderator' }, { token: await adminToken(app, owner) });
    expect(r.status).toBe(200);
    expect((await re.wait('force:logout'))[0]).toEqual({ reason: 'access_changed' });
    expect(await closed).toBe('io server disconnect');
    await sleep(300);
    expect(sb.connected).toBe(true);
    expect(rb.of('force:logout')).toEqual([]);
  });
});

describe('P5 limits', () => {
  it('20 events per 10 s per socket; the rest are dropped with an error event, and the socket stays usable', async () => {
    const g = await guest(app);
    const s = await live(g.accessToken);
    const rec = recorder(s, 'error');
    const results = await Promise.all(Array.from({ length: 28 }, async () => emit(s, 'time:sync', { t0: 1 }).then((r) => r.ok, () => 'dropped')));
    const answered = results.filter((r) => r === true).length, dropped = results.filter((r) => r === 'dropped').length;
    expect(answered).toBe(20);
    expect(dropped).toBe(8);
    expect(rec.of('error')).toEqual(Array.from({ length: 8 }, () => ({ code: 'RATE_LIMITED' })));
    expect(s.connected).toBe(true);
    await sleep(10_200); // the window passes
    expect((await emit(s, 'time:sync', { t0: 2 })).ok).toBe(true);
  }, 30_000);

  it('events with huge payloads are refused by the transport', async () => {
    const g = await guest(app);
    const s = await live(g.accessToken);
    const closed = new Promise<string>((res) => s.on('disconnect', res));
    s.emit('time:sync', { t0: 1, junk: 'x'.repeat(40_000) });
    expect(await Promise.race([closed, sleep(3000).then(() => 'still open')])).not.toBe('still open'); // 16 KB limit
  });
});

describe('P5 two API pods behind a load balancer', () => {
  it('an event published anywhere reaches every client exactly once, whichever pod holds the socket', async () => {
    const podB = await startPod();
    try {
      const [a, b, c] = await Promise.all([guest(app), guest(app), guest(app)]);
      const sa = await live(a.accessToken, {}, pod.url), sb = await live(b.accessToken, {}, podB.url), sc = await live(c.accessToken, {}, podB.url);
      const [ra, rb, rc] = [recorder(sa, 'config:changed', 'catalog:changed', 'live:agg'), recorder(sb, 'config:changed', 'catalog:changed', 'live:agg'), recorder(sc, 'config:changed', 'live:agg')];
      const tag = Math.floor(Math.random() * 1e6);
      // outbox rows are claimed by whichever relay gets there first (SKIP LOCKED); routers on both pods emit locally
      for (let i = 0; i < 20; i++) await q(`INSERT INTO outbox_events (topic, payload) VALUES ('config:changed', $1)`, [JSON.stringify({ key: `k${tag}`, version: i })]);
      for (const r of [ra, rb, rc]) await r.wait('config:changed', 20, (p) => p.key === `k${tag}`);
      await sleep(400);
      for (const r of [ra, rb, rc]) {
        const mine = r.of('config:changed').filter((p) => p.key === `k${tag}`);
        expect(mine).toHaveLength(20); // no duplicates despite two relays and two routers
        expect(new Set(mine.map((p) => p.version)).size).toBe(20);
      }
      // presence started on pod A is visible to a watcher on pod B
      const world = recorder(sc, 'live:agg');
      await emit(sc, 'room:join', { room: 'world' }); await emit(sa, 'room:join', { room: 'world' });
      world.clear(); ra.clear();
      await emit(sa, 'presence:start', { meditationId: uuid(), kind: 'solo', mode: 'solo' });
      await ticker.presenceTick(); // the scheduler would do this
      expect((await world.wait('live:agg', 1, (p) => p.total === 1))[0].total).toBe(1); // pod B
      expect((await ra.wait('live:agg', 1, (p) => p.total === 1))[0].total).toBe(1); // pod A
      expect(world.of('live:agg').filter((p) => p.total === 1)).toHaveLength(1);
      // a force logout reaches a socket on the other pod
      const closed = new Promise<string>((res) => sb.on('disconnect', res));
      await app.get(TokensService).bumpTokenVersion(b.me.id);
      expect(await closed).toBe('io server disconnect');
      // admin events cross pods too
      const admin = await makeAdmin(db, 'admin');
      const cmsB = await adminSock(await adminToken(app, admin), podB.url);
      const cmsRec = recorder(cmsB, 'entity:changed');
      const r = await http(app).post('/v1/admin/themes', { name: 'Cross Pod' }, { token: await adminToken(app, admin) }); // written via pod A's HTTP
      await cmsRec.wait('entity:changed', 1, (p) => p.id === r.body.data.id);
    } finally { await podB.stop(); }
  });

  it('a pod that goes away takes its sockets with it; clients on the other pod are unaffected', async () => {
    const podB = await startPod();
    const g = await guest(app), h2 = await guest(app);
    const onA = await live(g.accessToken, {}, pod.url), onB = await live(h2.accessToken, {}, podB.url);
    const closed = new Promise<string>((res) => onB.on('disconnect', res));
    await podB.stop();
    expect(await closed).toMatch(/server|transport/);
    await sleep(100);
    expect(onA.connected).toBe(true);
    expect((await emit(onA, 'time:sync', { t0: 1 })).ok).toBe(true);
    await waitFor(() => onA.connected, 1000);
  });
});
