import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type Redis from 'ioredis';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RealtimeBus, type BusEvent } from '../src/infra/realtime-bus';
import { K, REDIS } from '../src/infra/redis';
import { QUEUES, QueueService } from '../src/jobs/queues';
import { LiveService } from '../src/modules/live/live.service';
import { GroupStartService, LEAD_MS } from '../src/realtime/group-start.service';
import { LobbyService } from '../src/realtime/lobby.service';
import { HIDDEN_COUNTRY, PRESENCE_STALE_MS, PresenceService } from '../src/realtime/presence.service';
import { regionOf } from '../src/realtime/regions';
import { MONTHLY_USD, RealtimeTicker } from '../src/realtime/ticker';
import { EMA_ALPHA, vibration } from '../src/realtime/vibration';
import { bootApp, guest, resetTestDb } from './helpers';
import { sleep } from './realtime-helpers';

let app: NestFastifyApplication;
let db: Client;
let redis: Redis;
let presence: PresenceService, lobby: LobbyService, ticker: RealtimeTicker, live: LiveService, groupStart: GroupStartService;
let events: BusEvent[];
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const dayIso = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const total = async () => (await live.snapshot(dayIso())).total;
const ev = (topic: string) => events.filter((e) => e.topic === topic).map((e) => e.payload as any); // eslint-disable-line @typescript-eslint/no-explicit-any
const start = (user: string, over: Record<string, unknown> = {}) => presence.start({ meditationId: uuid(), userId: user, sessionId: null, country: 'DE', mode: 'solo', ...over } as Parameters<PresenceService['start']>[0]);

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  redis = app.get(REDIS);
  presence = app.get(PresenceService); lobby = app.get(LobbyService); ticker = app.get(RealtimeTicker); live = app.get(LiveService); groupStart = app.get(GroupStartService);
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  events = [];
  await app.get(RealtimeBus).subscribe((e) => events.push(e));
});
beforeEach(async () => {
  const keys = await redis.keys('pz:*'); const more = await redis.keys('lobby:*'); const x = await redis.keys('dash:*'); const l = await redis.keys('live:*'); const g = await redis.keys('group:started:*');
  const all = [...keys, ...more, ...x, ...l, ...g, K.vibration, K.medsToday(dayIso()), K.minsToday(dayIso()), K.practiced(dayIso())];
  if (all.length) await redis.del(...all);
  events.length = 0;
  // fresh ticker memory: new instance state is private, so reset through a new "change" each test
  (ticker as any).lastAgg = ''; (ticker as any).lastSession.clear(); (ticker as any).lastLobby.clear(); (ticker as any).lastMotd.clear(); (ticker as any).lastKpis = ''; // eslint-disable-line @typescript-eslint/no-explicit-any
});
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P5 pure rules', () => {
  it('vibration: ratio to the usual, group bonus, clamp, EMA', () => {
    const base = { meditationsToday: 100, avgSameTime28d: 100, groupJoinedToday: 0, avgGroupJoined28d: 0, previous: null };
    expect(vibration(base)).toBe(50); // a normal day
    expect(vibration({ ...base, meditationsToday: 50 })).toBe(25);
    expect(vibration({ ...base, meditationsToday: 150 })).toBe(75);
    expect(vibration({ ...base, meditationsToday: 400 })).toBe(100); // clamped
    expect(vibration({ ...base, meditationsToday: 0 })).toBe(0);
    expect(vibration({ ...base, groupJoinedToday: 300, avgGroupJoined28d: 600 })).toBe(65); // +15
    expect(vibration({ ...base, meditationsToday: 100, groupJoinedToday: 5000, avgGroupJoined28d: 100 })).toBe(80); // bonus capped at 30
    expect(vibration({ ...base, groupJoinedToday: 10, avgGroupJoined28d: 0 })).toBe(80); // no group history: bonus uses max(1, avg)
    expect(vibration({ ...base, avgSameTime28d: 0, meditationsToday: 7 })).toBe(50); // no history: any activity is normal
    expect(vibration({ ...base, avgSameTime28d: 0, meditationsToday: 0 })).toBe(0);
    expect(vibration({ ...base, meditationsToday: 100, previous: 20 })).toBe(Math.round((EMA_ALPHA * 50 + (1 - EMA_ALPHA) * 20) * 10) / 10); // smoothed: 29
    expect(vibration({ ...base, meditationsToday: 400, previous: 100 })).toBe(100);
    const walk: number[] = []; let prev: number | null = null;
    for (let i = 0; i < 12; i++) { prev = vibration({ ...base, meditationsToday: 200, previous: prev }); walk.push(prev); }
    expect(walk[0]).toBe(100);
    expect(walk.every((v) => v >= 0 && v <= 100)).toBe(true);
    let up: number | null = 0;
    for (let i = 0; i < 20; i++) up = vibration({ ...base, meditationsToday: 100, previous: up });
    expect(up!).toBeGreaterThanOrEqual(49.9); // converges to the raw value (to the 0.1 it is rounded to), never overshoots
    expect(up!).toBeLessThanOrEqual(50);
  });

  it('regions for the lobby map', () => {
    expect([regionOf('DE'), regionOf('US'), regionOf('BR'), regionOf('PK'), regionOf('NG'), regionOf('AU'), regionOf('SA'), regionOf('ZZ')]).toEqual(['Europe', 'North America', 'South America', 'Asia', 'Africa', 'Oceania', 'Middle East', 'Other']);
  });

  it('monthly price table matches the products', () => {
    expect(MONTHLY_USD.wehum_monthly).toBe(9.99);
    expect(MONTHLY_USD.wehum_annual).toBeCloseTo(6.5833, 3);
    expect(MONTHLY_USD.wehum_annual_founding).toBeCloseTo(4.9167, 3);
  });
});

describe('P5 presence engine (atomic scripts in Redis)', () => {
  it('counts a user once, per country and per session', async () => {
    const [a, b] = [uuid(), uuid()];
    const s1 = uuid(), s2 = uuid();
    expect(await start(a, { sessionId: s1 })).toBe('started');
    expect(await total()).toBe(1);
    await start(a, { sessionId: s1 }); // same user, another meditation of the same session
    await start(a, { sessionId: s2 }); // …and of another session
    expect(await total()).toBe(1); // still one person
    expect(await presence.sessionLive(s1)).toEqual({ people: 1, countries: 1 });
    expect(await presence.sessionLive(s2)).toEqual({ people: 1, countries: 1 });
    await start(b, { sessionId: s1, country: 'US' });
    expect(await total()).toBe(2);
    expect(await presence.sessionLive(s1)).toEqual({ people: 2, countries: 2 });
    const snap = await live.snapshot(dayIso());
    expect(snap).toMatchObject({ total: 2, countries: 2, top: [{ c: 'DE', n: 1 }, { c: 'US', n: 1 }], quiet: true });
  });

  it('start is idempotent for the owner and forbidden for anyone else', async () => {
    const [a, b] = [uuid(), uuid()], id = uuid();
    expect(await presence.start({ meditationId: id, userId: a, country: 'DE', mode: 'solo' })).toBe('started');
    expect(await presence.start({ meditationId: id, userId: a, country: 'DE', mode: 'solo' })).toBe('refreshed');
    expect(await presence.start({ meditationId: id, userId: b, country: 'US', mode: 'solo' })).toBe('forbidden');
    expect(await total()).toBe(1);
  });

  it('stop removes exactly that meditation and cleans up; other people cannot stop it', async () => {
    const a = uuid(), b = uuid(), id1 = uuid(), id2 = uuid(), s = uuid();
    await presence.start({ meditationId: id1, userId: a, sessionId: s, country: 'DE', mode: 'solo' });
    await presence.start({ meditationId: id2, userId: a, sessionId: s, country: 'DE', mode: 'solo' });
    expect(await presence.stop(id1, b)).toBe(false); // not theirs
    expect(await total()).toBe(1);
    expect(await presence.stop(id1, a)).toBe(true);
    expect(await total()).toBe(1); // one meditation left → still present
    expect(await presence.sessionLive(s)).toEqual({ people: 1, countries: 1 });
    expect(await presence.stop(id2, a)).toBe(true);
    expect(await total()).toBe(0);
    expect(await presence.sessionLive(s)).toEqual({ people: 0, countries: 0 });
    expect(await presence.stop(id2, a)).toBe(false); // already gone
    expect((await redis.keys('pz:*')).sort()).toEqual([]); // nothing left behind: no zero counters, no hashes
  });

  it('beat refreshes; unknown or foreign meditations are refused', async () => {
    const a = uuid(), b = uuid(), id = uuid();
    await presence.start({ meditationId: id, userId: a, country: 'DE', mode: 'solo' }, Date.now() - 80_000);
    expect(await presence.beat(id, a)).toBe(true);
    expect(Number(await redis.zscore(K.presenceZ, id))).toBeGreaterThan(Date.now() - 2000);
    expect(await presence.beat(id, b)).toBe(false);
    expect(await presence.beat(uuid(), a)).toBe(false);
  });

  it('expiry: entries nobody refreshed for 90 s disappear (and so do their counters)', async () => {
    const [a, b] = [uuid(), uuid()], ida = uuid(), idb = uuid(), s = uuid();
    await presence.start({ meditationId: ida, userId: a, sessionId: s, country: 'DE', mode: 'solo' });
    await presence.start({ meditationId: idb, userId: b, sessionId: s, country: 'FR', mode: 'solo' });
    await redis.zadd(K.presenceZ, Date.now() - PRESENCE_STALE_MS - 1000, ida); // a stopped beating long ago
    expect(await presence.sweep()).toBe(1);
    expect(await total()).toBe(1);
    expect(await presence.sessionLive(s)).toEqual({ people: 1, countries: 1 });
    expect(await redis.exists(K.presenceMed(ida))).toBe(0);
    expect(await redis.exists(K.presenceUser(a))).toBe(0);
    expect(await presence.sweep()).toBe(0);
    await redis.zadd(K.presenceZ, Date.now() - PRESENCE_STALE_MS - 1, idb);
    expect(await presence.sweep(Date.now())).toBe(1);
    expect(await total()).toBe(0);
    expect(await redis.keys('pz:*')).toEqual([]);
  });

  it('a user whose beat is late by a bit is not dropped (the window is 90 s)', async () => {
    const a = uuid(), id = uuid();
    await presence.start({ meditationId: id, userId: a, country: 'DE', mode: 'solo' }, Date.now() - 60_000);
    expect(await presence.sweep()).toBe(0);
    expect(await total()).toBe(1);
  });

  it('privacy: a hidden country counts as a person, never as a country', async () => {
    await start(uuid(), { country: HIDDEN_COUNTRY });
    await start(uuid(), { country: HIDDEN_COUNTRY });
    await start(uuid(), { country: 'JP' });
    const snap = await live.snapshot(dayIso());
    expect(snap).toMatchObject({ total: 3, countries: 1, top: [{ c: 'JP', n: 1 }] });
    expect(JSON.stringify(snap)).not.toContain(HIDDEN_COUNTRY);
    const s = uuid();
    await start(uuid(), { sessionId: s, country: HIDDEN_COUNTRY });
    expect(await presence.sessionLive(s)).toEqual({ people: 1, countries: 0 });
  });

  it('300 concurrent starts then 300 concurrent stops leave exact numbers and no leftovers', async () => {
    const users = Array.from({ length: 100 }, () => uuid());
    const countries = ['DE', 'US', 'PK', 'BR', 'JP'];
    const ids: { id: string; user: string; session: string }[] = [];
    const sessions = [uuid(), uuid(), uuid()];
    for (const [i, user] of users.entries()) for (let k = 0; k < 3; k++) ids.push({ id: uuid(), user, session: sessions[(i + k) % 3]! });
    await Promise.all(ids.map((m, i) => presence.start({ meditationId: m.id, userId: m.user, sessionId: m.session, country: countries[Math.floor(i / 3) % 5]!, mode: 'solo' })));
    const snap = await live.snapshot(dayIso());
    expect(snap.total).toBe(100); // 100 people, 300 meditations
    expect(snap.countries).toBe(5);
    expect(snap.top.map((t) => t.n)).toEqual([20, 20, 20, 20, 20]);
    for (const s of sessions) expect((await presence.sessionLive(s)).people).toBe(100); // every user has one meditation in each session
    expect(await redis.zcard(K.presenceZ)).toBe(300);
    await Promise.all(ids.map((m) => presence.stop(m.id, m.user)));
    expect(await total()).toBe(0);
    expect(await redis.keys('pz:*')).toEqual([]);
  });

  it('reconcile rebuilds the counters from the active entries (drift guard)', async () => {
    const s = uuid();
    const [a, b, c] = [uuid(), uuid(), uuid()];
    await start(a, { sessionId: s, country: 'DE' }); await start(b, { sessionId: s, country: 'DE' }); await start(c, { country: 'US' });
    await redis.hset(K.aggCountry, { DE: 99, XX2: 5 }); await redis.hset(K.aggSession, { [s]: 42, ghost: 3 }); await redis.hset(K.presenceSessionCountries(s), { FR: 7 });
    expect((await live.snapshot(dayIso())).total).toBeGreaterThan(100); // corrupted
    expect(await presence.reconcile()).toEqual({ users: 3, sessions: 1 });
    expect(await live.snapshot(dayIso())).toMatchObject({ total: 3, countries: 2, top: [{ c: 'DE', n: 2 }, { c: 'US', n: 1 }] });
    expect(await presence.sessionLive(s)).toEqual({ people: 2, countries: 1 });
    expect(await presence.activeSessions()).toEqual({ [s]: 2 });
  });
});

describe('P5 presence: reconcile is exact under churn', () => {
  it('reconciling while 300 people start and 150 stop never loses or double counts anyone', async () => {
    const users = Array.from({ length: 300 }, () => uuid());
    const ids = users.map(() => uuid());
    const sessions = [uuid(), uuid()];
    const starts = users.map((u, i) => presence.start({ meditationId: ids[i]!, userId: u, sessionId: sessions[i % 2]!, country: ['DE', 'US', 'JP'][i % 3]!, mode: 'solo' }));
    const recs = Array.from({ length: 12 }, async (_, k) => { await sleep(k * 3); return presence.reconcile(); });
    await Promise.all([...starts, ...recs]);
    expect(await total()).toBe(300);
    const stops = users.slice(0, 150).map((u, i) => presence.stop(ids[i]!, u));
    const recs2 = Array.from({ length: 12 }, async (_, k) => { await sleep(k * 2); return presence.reconcile(); });
    await Promise.all([...stops, ...recs2]);
    expect(await total()).toBe(150);
    expect(await presence.reconcile()).toEqual({ users: 150, sessions: 2 });
    expect(await total()).toBe(150);
    expect((await presence.sessionLive(sessions[0]!)).people + (await presence.sessionLive(sessions[1]!)).people).toBe(150);
  });
});

describe('P5 lobby', () => {
  it('join / leave / waiting, regions, hidden country, stale members drop out', async () => {
    const date = dayIso(), now = Date.now();
    await lobby.join(date, 'u1', 'DE', now); await lobby.join(date, 'u2', 'FR', now); await lobby.join(date, 'u3', 'US', now); await lobby.join(date, 'u4', HIDDEN_COUNTRY, now); await lobby.join(date, 'u5', 'PK', now);
    const st = await lobby.state(date, now);
    expect(st).toMatchObject({ date, waiting: 5, countries: 4 });
    expect(st.regions).toEqual([{ r: 'Europe', n: 2 }, { r: 'Asia', n: 1 }, { r: 'North America', n: 1 }]); // the hidden one is in no region
    expect(st.startsAt).toBe(`${date}T16:00:00.000Z`);
    await lobby.leave(date, 'u1');
    expect((await lobby.state(date, now)).waiting).toBe(4);
    await lobby.join(date, 'old', 'DE', now - 120_000); // last seen 2 minutes ago
    expect((await lobby.state(date, now)).waiting).toBe(4);
    expect(await lobby.sweep(date, now)).toBe(1);
    await lobby.touch(date, ['u2', 'ghost'], now + 50_000); // refreshing a member keeps it fresh; a stranger is not added
    expect(await redis.zscore(K.lobby(date), 'u2')).toBe(String(now + 50_000));
    expect(await redis.zscore(K.lobby(date), 'ghost')).toBeNull();
    expect((await lobby.state(date, now + 100_000)).waiting).toBe(1); // everyone else expired, u2 was touched
  });
});

describe('P5 ticker: publishes only what changed', () => {
  it('live:agg once per change, never when nothing moved; join snapshot is stored', async () => {
    await ticker.presenceTick();
    expect(ev('live:agg')).toHaveLength(1);
    expect(ev('live:agg')[0]).toMatchObject({ total: 0, countries: 0, quiet: true });
    await ticker.presenceTick(); await ticker.presenceTick();
    expect(ev('live:agg')).toHaveLength(1); // nothing changed
    const a = uuid();
    await start(a, { country: 'DE' });
    await ticker.presenceTick();
    await sleep(30);
    expect(ev('live:agg')).toHaveLength(2);
    expect(ev('live:agg')[1]).toMatchObject({ total: 1, countries: 1, top: [{ c: 'DE', n: 1 }] });
    expect(JSON.parse((await redis.get(K.liveAggLast))!).total).toBe(1);
    await redis.set(K.medsToday(dayIso()), '5'); // meditated-today moved → changed
    await ticker.presenceTick(); await sleep(30);
    expect(ev('live:agg')).toHaveLength(3);
  });

  it('session:live only for changed sessions, with a final zero when a session empties', async () => {
    const s1 = uuid(), s2 = uuid(), a = uuid(), b = uuid(), id = uuid();
    await presence.start({ meditationId: id, userId: a, sessionId: s1, country: 'DE', mode: 'solo' });
    await start(b, { sessionId: s2, country: 'US' });
    await ticker.presenceTick(); await sleep(30);
    expect(ev('session:live').map((e) => e.sessionId).sort()).toEqual([s1, s2].sort());
    events.length = 0;
    await ticker.presenceTick(); await sleep(30);
    expect(ev('session:live')).toEqual([]);
    await start(uuid(), { sessionId: s1, country: 'FR' });
    await ticker.presenceTick(); await sleep(30);
    expect(ev('session:live')).toEqual([{ sessionId: s1, people: 2, countries: 2 }]); // only s1 changed
    events.length = 0;
    await presence.stop(id, a);
    await ticker.presenceTick(); await sleep(30);
    expect(ev('session:live')).toEqual([{ sessionId: s1, people: 1, countries: 1 }]);
    for (const m of await redis.zrange(K.presenceZ, '0', '-1')) await redis.zadd(K.presenceZ, 1, m);
    events.length = 0;
    await ticker.presenceTick(); await sleep(30);
    expect(ev('session:live').sort((x, y) => x.sessionId.localeCompare(y.sessionId))).toEqual([{ sessionId: s1, people: 0, countries: 0 }, { sessionId: s2, people: 0, countries: 0 }].sort((x, y) => x.sessionId.localeCompare(y.sessionId)));
    events.length = 0;
    await ticker.presenceTick(); await sleep(30);
    expect(ev('session:live')).toEqual([]); // the zero is sent once
  });

  it('lobby:state and motd:stats follow their data', async () => {
    const date = dayIso();
    expect(await ticker.lobbyTick()).toBe(2); // first look at today + tomorrow
    expect(await ticker.lobbyTick()).toBe(0);
    await lobby.join(date, 'u1', 'DE'); await lobby.join(date, 'u2', 'JP');
    expect(await ticker.lobbyTick()).toBe(1);
    await sleep(30);
    expect(ev('lobby:state').at(-1)).toMatchObject({ date, waiting: 2, countries: 2, regions: [{ r: 'Asia', n: 1 }, { r: 'Europe', n: 1 }] });
    expect(await ticker.motdStatsTick()).toBe(3); // yesterday, today, tomorrow
    expect(await ticker.motdStatsTick()).toBe(0);
    await redis.sadd(K.practiced(date), 'a', 'b', 'c');
    expect(await ticker.motdStatsTick()).toBe(1);
    await sleep(30);
    expect(ev('motd:stats').at(-1)).toEqual({ date, practicedToday: 3 });
  });

  it('the leader sweeps expired presence before it publishes', async () => {
    const a = uuid(), id = uuid();
    await presence.start({ meditationId: id, userId: a, country: 'DE', mode: 'solo' });
    await ticker.presenceTick(); await sleep(30);
    expect(ev('live:agg').at(-1).total).toBe(1);
    await redis.zadd(K.presenceZ, Date.now() - 200_000, id);
    await ticker.presenceTick(); await sleep(30);
    expect(ev('live:agg').at(-1).total).toBe(0);
  });
});

describe('P5 dashboard KPIs + vibration job', () => {
  it('KPIs come from presence, today counters, entitlements, the founding offer and flagged dedications', async () => {
    const date = dayIso();
    const [t1, t2, p1, p2, p3, expired] = await Promise.all(Array.from({ length: 6 }, () => guest(app)));
    const ent = (u: { me: { id: string } }, product: string, period: string, exp: string) => q(`INSERT INTO entitlements (user_id, active, product_id, period_type, expires_at) VALUES ($1, true, $2, $3, now() + interval '${exp}') ON CONFLICT (user_id) DO NOTHING`, [u.me.id, product, period]);
    await ent(t1!, 'wehum_annual', 'trial', '5 days'); await ent(t2!, 'wehum_monthly', 'trial', '5 days');
    await ent(p1!, 'wehum_annual', 'normal', '300 days'); await ent(p2!, 'wehum_annual_founding', 'normal', '300 days'); await ent(p3!, 'wehum_monthly', 'normal', '20 days');
    await q(`INSERT INTO entitlements (user_id, active, product_id, period_type, expires_at) VALUES ($1, true, 'wehum_monthly', 'normal', now() - interval '1 day')`, [expired!.me.id]); // lapsed: not counted
    await redis.del('dash:subs');
    await q(`UPDATE offers SET taken = 214, cap = 1000, open = true WHERE id='founding'`);
    await redis.set(K.medsToday(date), '321'); await redis.set(K.minsToday(date), '4020');
    await start(uuid(), { country: 'DE' }); await start(uuid(), { country: 'US' });
    const sess = (await q<{ id: string }>(`SELECT id FROM sessions LIMIT 1`))[0]!.id;
    const author = await guest(app);
    for (const [st, mid] of [['flagged', uuid()], ['flagged', uuid()], ['visible', uuid()], ['hidden', uuid()]] as const) {
      await q(`INSERT INTO dedications (id, session_id, user_id, meditation_id, first_name, text, status) VALUES ($1,$2,$3,$4,'Ann','hello',$5)`, [uuid(), sess, author.me.id, mid, st]);
    }
    const k = await ticker.kpis();
    expect(k).toMatchObject({
      liveNow: 2, meditationsToday: 321, minutesToday: 4020, payingMembers: 3, inTrial: 2,
      founding: { taken: 214, cap: 1000, open: true }, moderationOpen: 2,
    });
    expect(k.mrrUsd).toBeCloseTo(79 / 12 + 59 / 12 + 9.99, 1); // trials are not revenue yet
    expect(Math.abs(k.at - Date.now())).toBeLessThan(2000);
    await q(`UPDATE offers SET taken = 1000 WHERE id='founding'`);
    expect((await ticker.kpis()).founding).toEqual({ taken: 1000, cap: 1000, open: false });
    await q(`UPDATE offers SET taken = 0, open = true WHERE id='founding'`);
  });

  it('dashboard:kpis is published when something changed, and kept for new subscribers', async () => {
    expect(await ticker.kpiTick()).toBe(true);
    expect(await ticker.kpiTick()).toBe(false); // same numbers (the clock is not a change)
    await redis.set(K.medsToday(dayIso()), '999');
    expect(await ticker.kpiTick()).toBe(true);
    await sleep(30);
    expect(ev('dashboard:kpis').at(-1)).toMatchObject({ meditationsToday: 999 });
    expect(JSON.parse((await redis.get(K.dashKpisLast))!).meditationsToday).toBe(999);
  });

  it('recording a meditation moves the minutes-today and meditations-today counters', async () => {
    const g = await guest(app);
    const { http } = await import('./helpers');
    const body = { id: uuid(), kind: 'solo', startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), endedAt: new Date(Date.now() - 5 * 60_000).toISOString(), durationSec: 900 };
    // fixed past local date so the counters are those of that date
    const r = await http(app).post('/v1/meditations', body, { token: g.accessToken });
    expect(r.status).toBe(201);
    const date = r.body.data.localDate as string;
    expect(Number(await redis.get(K.medsToday(date)))).toBeGreaterThanOrEqual(1);
    expect(Number(await redis.get(K.minsToday(date)))).toBeGreaterThanOrEqual(15);
    await redis.del(K.medsToday(date), K.minsToday(date), K.practiced(date));
  });

  it('vibration job: reads today vs the usual, smooths with the previous value, stores it', async () => {
    const now = Date.now();
    const i0 = await ticker.vibrationInput(now);
    expect(i0).toMatchObject({ meditationsToday: 0, groupJoinedToday: 0, previous: null });
    await redis.set(K.medsToday(dayIso()), '40');
    await q(`UPDATE motd_days SET group_joined = 120 WHERE date=$1`, [dayIso()]);
    const v1 = await ticker.vibrationTick(now);
    expect(v1).toBeGreaterThan(0);
    expect(v1).toBeLessThanOrEqual(100);
    expect(Number(await redis.get(K.vibration))).toBe(v1);
    const input = await ticker.vibrationInput(now);
    expect(input.previous).toBe(v1);
    expect(input.groupJoinedToday).toBe(120);
    const v2 = await ticker.vibrationTick(now);
    expect(v2).toBe(vibration(input)); // second run uses the first as "previous"
    await q(`UPDATE motd_days SET group_joined = 0 WHERE date=$1`, [dayIso()]);
    // the average over the last 28 days is computed in SQL from real meditations
    const u = await guest(app);
    for (let d = 1; d <= 4; d++) {
      const at = new Date(now - d * 86_400_000 - 3600_000);
      await q(`INSERT INTO meditations (id, user_id, kind, started_at, ended_at, duration_sec, counted, completed, local_date) VALUES ($1,$2,'solo',$3,$4,600,true,true,$5)`, [uuid(), u.me.id, at, new Date(at.getTime() + 600_000), at.toISOString().slice(0, 10)]);
    }
    const withHistory = await ticker.vibrationInput(now);
    expect(withHistory.avgSameTime28d).toBeGreaterThan(0); // 4 meditations an hour before "now" on earlier days, within 28 days
  });

  it('reconcile tick returns what it rebuilt', async () => {
    await start(uuid()); await start(uuid());
    expect(await ticker.reconcileTick()).toMatchObject({ users: 2 });
  });
});

describe('P5 group start (T0)', () => {
  const setStart = async (hhmm: string) => { await q(`UPDATE app_config SET value = value || $1::jsonb, version = version + 1 WHERE key='group'`, [JSON.stringify({ startUtc: hhmm })]); await redis.del(K.config('group'), ...(await redis.keys('motd:*'))); };
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const clearQueue = async () => { await app.get(QueueService).queue(QUEUES.cron).obliterate({ force: true }); };

  it('schedules a delayed job only for starts within the next 16 minutes; the job id carries the start instant', async () => {
    await clearQueue();
    const now = Date.parse(`${dayIso()}T12:00:00Z`);
    await setStart('12:10');
    const queued = await groupStart.schedule(now);
    expect(queued).toEqual([`group-start-${dayIso()}-${Date.parse(`${dayIso()}T12:10:00Z`)}`]);
    const job = await app.get(QueueService).queue(QUEUES.cron).getJob(queued[0]!);
    expect(job!.opts.delay).toBe(10 * 60_000 - LEAD_MS); // runs 1.5 s early and waits for the exact instant
    expect(await groupStart.schedule(now)).toEqual(queued); // idempotent: same job id, no duplicate
    expect((await app.get(QueueService).queue(QUEUES.cron).getJobCounts('delayed')).delayed).toBe(1);
    await clearQueue();
    await setStart('12:30'); // 30 min away: too early
    expect(await groupStart.schedule(now)).toEqual([]);
    await setStart('11:50'); // already started 10 min ago: too late for today… tomorrow's 11:50 is far away
    expect(await groupStart.schedule(now)).toEqual([]);
    await clearQueue();
    const late = Date.parse(`${dayIso()}T23:55:00Z`);
    await setStart('00:05'); // just after midnight: tomorrow's start is within the window
    const tomorrow = await groupStart.schedule(late);
    expect(tomorrow).toEqual([`group-start-${dayIso(1)}-${Date.parse(`${dayIso(1)}T00:05:00Z`)}`]);
    await setStart('16:00'); await clearQueue();
  });

  it('fire: announces to the lobby, snapshots who was waiting, only once; stale jobs do nothing', async () => {
    const date = dayIso();
    await setStart('16:00');
    const startsAt = Date.parse(`${date}T16:00:00Z`);
    await q(`UPDATE motd_days SET group_joined = 0 WHERE date=$1`, [date]);
    const now = Date.now();
    await lobby.join(date, 'u1', 'DE', now); await lobby.join(date, 'u2', 'US', now); await lobby.join(date, 'u3', 'PK', now - 200_000); // the third is long gone
    expect(await groupStart.fire(date, startsAt, now)).toBe(true);
    await sleep(30);
    const sessionId = (await q<{ session_id: string }>(`SELECT session_id FROM motd_days WHERE date=$1`, [date]))[0]!.session_id;
    expect(ev('group:start')).toEqual([{ date, startsAt: `${date}T16:00:00.000Z`, sessionId, lengthMin: 30, mediaKey: `motd:${date}:30` }]);
    expect((await q<{ group_joined: number }>(`SELECT group_joined FROM motd_days WHERE date=$1`, [date]))[0]!.group_joined).toBe(2);
    expect(await groupStart.fire(date, startsAt, now)).toBe(false); // a retried job does not announce twice
    expect(ev('group:start')).toHaveLength(1);
    expect(await groupStart.fire(date, startsAt + 3_600_000, now)).toBe(false); // the CMS moved the time: the old job is stale
    await setStart('18:00');
    expect(await groupStart.fire(date, startsAt, now)).toBe(false);
    await setStart('16:00'); await redis.del(...(await redis.keys('group:started:*')));
  });
});
