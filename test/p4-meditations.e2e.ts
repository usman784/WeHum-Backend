import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type Redis from 'ioredis';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { K, REDIS } from '../src/infra/redis';
import { QUEUES, QueueService } from '../src/jobs/queues';
import { WorkerRunner } from '../src/jobs/workers';
import { CountersService } from '../src/modules/meditations/counters.service';
import { isCounted, localDate } from '../src/modules/meditations/meditation.rules';
import { StatsProcessor } from '../src/modules/meditations/stats.processor';
import { ProgressService } from '../src/modules/me/progress.service';
import { bootApp, clearRates, guest, http, member, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let redis: Redis;
let runner: WorkerRunner;
const h = () => http(app);
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const dayIso = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const drain = () => runner.idle([QUEUES.stats], app.get(QueueService), 20_000);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** A meditation that ended `endedMinAgo` minutes ago and lasted `sec` seconds. */
const med = (over: Record<string, unknown> = {}, sec = 600, endedMinAgo = 5) => ({
  id: uuid(), kind: 'solo', startedAt: new Date(Date.now() - endedMinAgo * 60_000 - sec * 1000).toISOString(), endedAt: ago(endedMinAgo), durationSec: sec, completed: true, ...over,
});
const sessionOf = async (access = 'premium') => (await q<{ id: string; duration_sec: number }>(`SELECT id, duration_sec FROM sessions WHERE status='live' AND NOT is_sos AND access=$1 ORDER BY slug LIMIT 1`, [access]))[0]!;

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  redis = app.get(REDIS);
  runner = app.get(WorkerRunner); runner.start();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
beforeEach(async () => { await clearRates(); });
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P4 counting rule + local date (unit)', () => {
  it('counts ≥ 180 s, or ≥ 50 % of a session shorter than 6 minutes', () => {
    expect(isCounted(180)).toBe(true);
    expect(isCounted(179)).toBe(false);
    expect(isCounted(1800, 1800)).toBe(true);
    expect(isCounted(90, 180)).toBe(true); // 50 % of a 3-minute session
    expect(isCounted(89, 180)).toBe(false);
    expect(isCounted(60, 120)).toBe(true);
    expect(isCounted(100, 359)).toBe(false); // < 50 % of 359 s and < 180 s
    expect(isCounted(180, 359)).toBe(true);
    expect(isCounted(120, 1200)).toBe(false); // long sessions need the 180 s
    expect(isCounted(0)).toBe(false);
  });

  it('local date follows the time zone, including DST days', () => {
    const at = new Date('2026-10-05T23:30:00Z');
    expect(localDate(at, 'UTC')).toBe('2026-10-05');
    expect(localDate(at, 'Asia/Tokyo')).toBe('2026-10-06');
    expect(localDate(at, 'America/Los_Angeles')).toBe('2026-10-05');
    expect(localDate(new Date('2026-10-25T22:30:00Z'), 'Europe/Berlin')).toBe('2026-10-25'); // 23:30, still CET/CEST changeover day
    expect(localDate(new Date('2026-10-25T23:30:00Z'), 'Europe/Berlin')).toBe('2026-10-26'); // 00:30 after the clocks went back
    expect(localDate(new Date('2026-03-29T00:30:00Z'), 'Europe/Berlin')).toBe('2026-03-29');
    expect(localDate(new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('2026-11-01'); // 01:30 EDT/EST fall-back hour
    expect(localDate(new Date('2026-10-04T14:00:00Z'), 'Pacific/Auckland')).toBe('2026-10-05');
    expect(localDate(new Date('2026-10-05T00:30:00Z'), 'Asia/Kolkata')).toBe('2026-10-05'); // half-hour offset
  });
});

describe('P4 POST /v1/meditations', () => {
  it('records, decides counted + localDate on the server, returns the payoff data', async () => {
    const g = await member(app, db);
    await q(`UPDATE users SET timezone='Asia/Tokyo', is_guest=false, country='JP' WHERE id=$1`, [g.me.id]);
    const s = await sessionOf();
    const body = med({ sessionId: s.id, kind: 'motd', lengthVariant: 30, startedAt: `${dayIso(-2)}T23:30:00.000Z`, endedAt: `${dayIso(-2)}T23:50:00.000Z` }, 1200);
    const r = await h().post('/v1/meditations', body, { token: g.accessToken });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ id: body.id, counted: true, localDate: dayIso(-1), canDedicate: true, dedicationsLeftToday: 3, together: { people: 0, countries: 0 } });
    const [row] = await q<{ counted: boolean; local_date: string; country: string; user_id: string; session_id: string }>(`SELECT counted, local_date::text, country, user_id, session_id FROM meditations WHERE id=$1`, [body.id]);
    expect(row).toMatchObject({ counted: true, local_date: dayIso(-1), country: 'JP', user_id: g.me.id, session_id: s.id });
  });

  it('short ones do not count; the 50 % rule applies to short sessions', async () => {
    const g = await guest(app);
    const long = await sessionOf();
    const short = (await q<{ id: string }>(`INSERT INTO sessions (id, slug, title, type, access, duration_sec, status) VALUES ($1,$2,'Three Minutes','audio','premium',180,'live') RETURNING id`, [uuid(), `three-${Math.random().toString(36).slice(2, 7)}`]))[0]!;
    const post = (b: object) => h().post('/v1/meditations', b, { token: g.accessToken }).then((r) => r.body.data.counted);
    expect(await post(med({ sessionId: long.id }, 120))).toBe(false);
    expect(await post(med({ sessionId: long.id }, 180))).toBe(true);
    expect(await post(med({ sessionId: short.id }, 89))).toBe(false);
    expect(await post(med({ sessionId: short.id }, 90))).toBe(true);
    expect(await post(med({}, 60))).toBe(false); // no session
  });

  it('validates times and shape', async () => {
    const g = await guest(app);
    const post = (b: object) => h().post('/v1/meditations', b, { token: g.accessToken });
    const future = await post(med({ startedAt: new Date(Date.now() + 10 * 60_000).toISOString(), endedAt: new Date(Date.now() + 20 * 60_000).toISOString() }, 600));
    expect(future.status).toBe(422);
    expect(future.body.error.code).toBe('INVALID_STATE');
    expect((await post(med({ startedAt: new Date(Date.now() + 3 * 60_000).toISOString(), endedAt: new Date(Date.now() + 14 * 60_000).toISOString() }, 600))).status).toBe(201); // ±5 min clock skew
    expect((await post(med({ endedAt: ago(30) }, 600))).body.error.code).toBe('INVALID_STATE'); // ended before it started
    expect((await post(med({ startedAt: ago(5 * 60 + 10), endedAt: ago(10) }, 600))).body.error.code).toBe('INVALID_STATE'); // longer than 4 h
    expect((await post(med({}, 3600, 5)) .then((r) => r.status))).toBe(201);
    expect((await post(med({ durationSec: 2000 }, 600))).body.error.code).toBe('INVALID_STATE'); // longer than the time between start and end
    expect((await post(med({ durationSec: 4 * 3600 + 1 }))).status).toBe(400);
    expect((await post(med({ durationSec: 0 }))).status).toBe(400);
    expect((await post(med({ kind: 'nap' }))).status).toBe(400);
    expect((await post(med({ id: 'abc' }))).status).toBe(400);
    expect((await post(med({ lengthVariant: 20 }))).status).toBe(400);
    expect((await post(med({ startedAt: 'yesterday' }))).status).toBe(400);
    expect((await post({ ...med(), counted: true })).status).toBe(400); // the client cannot decide
    expect((await h().post('/v1/meditations', med())).status).toBe(401);
  });

  it('is idempotent by client id; another user cannot take over an id', async () => {
    const a = await guest(app), b = await guest(app);
    const body = med();
    const first = await h().post('/v1/meditations', body, { token: a.accessToken });
    const again = await h().post('/v1/meditations', body, { token: a.accessToken });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    expect((await q(`SELECT 1 FROM meditations WHERE id=$1`, [body.id]))).toHaveLength(1);
    const steal = await h().post('/v1/meditations', body, { token: b.accessToken });
    expect(steal.status).toBe(409);
    expect(steal.body.error.code).toBe('ALREADY_EXISTS');
    await drain();
    expect((await q<{ meditations: number }>(`SELECT meditations FROM user_daily_stats WHERE user_id=$1`, [a.me.id]))[0]!.meditations).toBe(1); // counted once
  });

  it('a deleted session does not make an (offline) meditation fail', async () => {
    const g = await guest(app);
    const r = await h().post('/v1/meditations', med({ sessionId: uuid(), offline: true }), { token: g.accessToken });
    expect(r.status).toBe(201);
    expect((await q<{ session_id: string | null; offline: boolean }>(`SELECT session_id, offline FROM meditations WHERE id=$1`, [r.body.data.id]))[0]).toEqual({ session_id: null, offline: true });
  });

  it('canDedicate needs a member with an account and a finished counted meditation', async () => {
    const s = await sessionOf();
    const free = await guest(app), guestMember = await member(app, db), acct = await member(app, db);
    await q(`UPDATE users SET is_guest=false WHERE id=$1`, [acct.me.id]);
    const can = async (t: string, over: object = {}) => (await h().post('/v1/meditations', med({ sessionId: s.id, ...over }), { token: t })).body.data.canDedicate;
    expect(await can(free.accessToken)).toBe(false);
    expect(await can(guestMember.accessToken)).toBe(false); // member but still a guest
    expect(await can(acct.accessToken)).toBe(true);
    expect(await can(acct.accessToken, { completed: false })).toBe(false);
    expect(await can(acct.accessToken, { sessionId: null })).toBe(false);
    await redis.set(K.dedLimit(acct.me.id, dayIso()), '3', 'EX', 60);
    const full = await h().post('/v1/meditations', med({ sessionId: s.id }), { token: acct.accessToken });
    expect(full.body.data).toMatchObject({ canDedicate: false, dedicationsLeftToday: 0 });
  });

  it('feeds the live counters: practiced set and meditated-today counter (counted only)', async () => {
    const g = await guest(app);
    const date = dayIso(-3);
    await redis.del(K.practiced(date), K.medsToday(date));
    const at = { startedAt: `${date}T10:00:00.000Z`, endedAt: `${date}T10:10:00.000Z` };
    await h().post('/v1/meditations', med(at, 600), { token: g.accessToken });
    await h().post('/v1/meditations', med({ startedAt: `${date}T11:00:00.000Z`, endedAt: `${date}T11:10:00.000Z` }, 600), { token: g.accessToken }); // same user again
    await h().post('/v1/meditations', med({ startedAt: `${date}T12:00:00.000Z`, endedAt: `${date}T12:00:30.000Z` }, 30), { token: g.accessToken }); // too short
    expect(await redis.scard(K.practiced(date))).toBe(1); // exact unique users
    expect(await redis.get(K.medsToday(date))).toBe('2');
    expect(await redis.ttl(K.practiced(date))).toBeGreaterThan(0);
  });
});

describe('P4 stats job', () => {
  it('applies daily + lifetime stats once, even if the job runs twice', async () => {
    const g = await guest(app);
    await q(`UPDATE users SET timezone='UTC' WHERE id=$1`, [g.me.id]);
    const d = dayIso(-4);
    const a = med({ kind: 'solo', startedAt: `${d}T08:00:00Z`, endedAt: `${d}T08:10:00Z` }, 600);       // 10 min
    const b = med({ kind: 'group', startedAt: `${d}T16:00:00Z`, endedAt: `${d}T16:30:00Z` }, 1800);     // 30 min, together
    const c = med({ kind: 'solo', startedAt: `${d}T20:00:00Z`, endedAt: `${d}T20:01:00Z` }, 60);        // too short: ignored
    const e = med({ kind: 'solo', startedAt: `${dayIso(-5)}T20:00:00Z`, endedAt: `${dayIso(-5)}T20:07:20Z` }, 440); // 7.33 → 7 min
    for (const m of [a, b, c, e]) expect((await h().post('/v1/meditations', m, { token: g.accessToken })).status).toBe(201);
    await drain();
    const daily = await q<{ local_date: string; minutes: number; meditations: number; group_count: number }>(`SELECT local_date::text, minutes, meditations, group_count FROM user_daily_stats WHERE user_id=$1 ORDER BY local_date`, [g.me.id]);
    expect(daily).toEqual([{ local_date: dayIso(-5), minutes: 7, meditations: 1, group_count: 0 }, { local_date: d, minutes: 40, meditations: 2, group_count: 1 }]);
    const [t] = await q<{ minutes_total: number; meditations_total: number; group_total: number; first: string; last: string }>(`SELECT minutes_total, meditations_total, group_total, first_meditation_at::text first, last_meditation_at::text last FROM user_stats WHERE user_id=$1`, [g.me.id]);
    expect(t).toMatchObject({ minutes_total: 47, meditations_total: 3, group_total: 1 });
    expect(new Date(t!.first).toISOString()).toBe(`${dayIso(-5)}T20:00:00.000Z`);
    expect(new Date(t!.last).toISOString()).toBe(`${d}T16:30:00.000Z`);

    const stats = app.get(StatsProcessor);
    expect(await stats.apply(a.id)).toBe(false); // already applied
    expect(await stats.apply(uuid())).toBe(false); // unknown id (and does not poison the marker)
    expect((await q<{ minutes_total: number }>(`SELECT minutes_total FROM user_stats WHERE user_id=$1`, [g.me.id]))[0]!.minutes_total).toBe(47);
  });

  it('a failed run can be retried and counts exactly once', async () => {
    const g = await guest(app);
    const m = med();
    await h().post('/v1/meditations', m, { token: g.accessToken });
    await drain();
    await redis.del(K.statsDone(m.id)); // the job was lost before it was recorded as applied…
    await q(`DELETE FROM user_daily_stats WHERE user_id=$1`, [g.me.id]); await q(`DELETE FROM user_stats WHERE user_id=$1`, [g.me.id]);
    expect(await app.get(StatsProcessor).apply(m.id)).toBe(true); // …so the retry rebuilds it
    expect((await q<{ meditations_total: number }>(`SELECT meditations_total FROM user_stats WHERE user_id=$1`, [g.me.id]))[0]!.meditations_total).toBe(1);
  });

  it('session plays/completions and MOTD solo counts are batched through Redis', async () => {
    const [s1] = await q<{ id: string; plays: number; completions: number }>(`SELECT id, plays, completions FROM sessions WHERE status='live' AND NOT is_sos ORDER BY slug LIMIT 1 OFFSET 7`);
    const g1 = await guest(app), g2 = await guest(app);
    const today = dayIso(0);
    await q(`INSERT INTO motd_days (date, session_id, solo_count) VALUES ($1,$2,0) ON CONFLICT (date) DO UPDATE SET solo_count=0, practiced_today=0`, [today, s1!.id]);
    await redis.del(K.practiced(today));
    const base = { sessionId: s1!.id, kind: 'motd' };
    await h().post('/v1/meditations', med({ ...base, completed: true }), { token: g1.accessToken });
    await h().post('/v1/meditations', med({ ...base, completed: false }), { token: g2.accessToken });
    await h().post('/v1/meditations', med({ ...base, completed: true }, 30), { token: g2.accessToken }); // uncounted still a play
    await drain();
    expect((await q<{ plays: number }>(`SELECT plays FROM sessions WHERE id=$1`, [s1!.id]))[0]!.plays).toBe(s1!.plays); // not yet written: Redis holds the batch
    const out = await app.get(CountersService).flush();
    expect(out.sessions).toBeGreaterThanOrEqual(2);
    const [after] = await q<{ plays: number; completions: number }>(`SELECT plays, completions FROM sessions WHERE id=$1`, [s1!.id]);
    expect(after).toEqual({ plays: s1!.plays + 3, completions: s1!.completions + 2 });
    const [motd] = await q<{ solo_count: number; practiced_today: number }>(`SELECT solo_count, practiced_today FROM motd_days WHERE date=$1`, [today]);
    expect(motd).toEqual({ solo_count: 2, practiced_today: 2 }); // 2 counted solo meditations by 2 users
    await app.get(CountersService).flush(); // nothing left → no double counting
    expect((await q<{ plays: number }>(`SELECT plays FROM sessions WHERE id=$1`, [s1!.id]))[0]!.plays).toBe(s1!.plays + 3);
  });
});

describe('P4 offline batch', () => {
  it('per-item results; duplicates and bad items do not block the rest; re-sending is safe', async () => {
    const g = await guest(app);
    const good1 = med({ offline: true }), good2 = med({ offline: true }), bad = med({ durationSec: 9999 }, 600);
    const r = await h().post('/v1/meditations/batch', { items: [good1, bad, good2, good1] }, { token: g.accessToken });
    expect(r.status).toBe(200);
    expect(r.body.data.results.map((x: { status: string }) => x.status)).toEqual(['created', 'rejected', 'created', 'duplicate']);
    expect(r.body.data.results[1]).toMatchObject({ id: bad.id, error: { code: 'INVALID_STATE' } });
    expect(r.body.data).toMatchObject({ created: 2, duplicates: 1, rejected: 1 });
    const again = await h().post('/v1/meditations/batch', { items: [good1, good2] }, { token: g.accessToken });
    expect(again.body.data).toMatchObject({ created: 0, duplicates: 2, rejected: 0 });
    await drain();
    expect((await q<{ meditations: number }>(`SELECT meditations FROM user_daily_stats WHERE user_id=$1`, [g.me.id]))[0]!.meditations).toBe(2);
  });

  it('limits: 1–100 items, strict items, own rate bucket', async () => {
    const g = await guest(app);
    const items = (n: number) => Array.from({ length: n }, () => med({ offline: true }, 200));
    expect((await h().post('/v1/meditations/batch', { items: [] }, { token: g.accessToken })).status).toBe(400);
    expect((await h().post('/v1/meditations/batch', { items: items(101) }, { token: g.accessToken })).status).toBe(400);
    const hundred = await h().post('/v1/meditations/batch', { items: items(100) }, { token: g.accessToken });
    expect(hundred.status).toBe(200);
    expect(hundred.body.data.created).toBe(100);
    expect((await h().post('/v1/meditations/batch', { items: [{ ...med(), extra: 1 }] }, { token: g.accessToken })).status).toBe(400);
    expect((await h().post('/v1/meditations/batch', { items: items(1) })).status).toBe(401);
    await drain();
  });
});

describe('P4 history', () => {
  it('newest first, keyset pagination, only my meditations, with the session title', async () => {
    const g = await guest(app), other = await guest(app);
    const s = await sessionOf();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const m = med({ sessionId: i % 2 ? s.id : undefined, startedAt: `${dayIso(-10 + i)}T09:00:00.000Z`, endedAt: `${dayIso(-10 + i)}T09:10:00.000Z` }, 600);
      ids.push(m.id); await h().post('/v1/meditations', m, { token: g.accessToken });
    }
    await h().post('/v1/meditations', med(), { token: other.accessToken });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const r = await h().get(`/v1/meditations?limit=3${cursor ? `&cursor=${cursor}` : ''}`, { token: g.accessToken });
      expect(r.status).toBe(200);
      seen.push(...r.body.data.map((m: { id: string }) => m.id));
      cursor = r.body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([...ids].reverse());
    const first = (await h().get('/v1/meditations?limit=7', { token: g.accessToken })).body.data;
    expect(first[0]).toMatchObject({ id: ids[6], sessionId: null, sessionTitle: null, counted: true, localDate: dayIso(-4), kind: 'solo' });
    expect(first[1]).toMatchObject({ id: ids[5], sessionId: s.id, sessionTitle: expect.any(String) });
    expect((await h().get('/v1/meditations?limit=0', { token: g.accessToken })).status).toBe(400);
    expect((await h().get('/v1/meditations')).status).toBe(401);
  });
});

describe('P4 progress (no streaks)', () => {
  const tzOf = (userId: string, tz: string) => q(`UPDATE users SET timezone=$2 WHERE id=$1`, [userId, tz]);
  const day = (userId: string, date: string, minutes: number, meditations: number, group = 0) =>
    q(`INSERT INTO user_daily_stats (user_id, local_date, minutes, meditations, group_count) VALUES ($1,$2,$3,$4,$5)`, [userId, date, minutes, meditations, group]);

  it('week: ISO week (Mon–Sun) in the user tz, totals, average, days, bars', async () => {
    const g = await guest(app);
    const svc = app.get(ProgressService);
    const now = new Date('2026-10-08T10:00:00Z'); // Thursday
    await day(g.me.id, '2026-10-05', 30, 2, 1); // Monday
    await day(g.me.id, '2026-10-07', 45, 3, 2);
    await day(g.me.id, '2026-10-11', 30, 2); // Sunday (later this week)
    await day(g.me.id, '2026-10-04', 99, 9); // previous Sunday: not this week
    const p = await svc.progress(g.me.id, 'UTC', 'week', now);
    expect(p).toMatchObject({ period: 'week', from: '2026-10-05', to: '2026-10-11', minutes: 105, meditations: 7, together: 3, average: 15, daysMeditated: 3 });
    expect(p.daysThisWeek).toEqual([true, false, true, false, false, false, true]);
    expect(p.bars.map((b) => b.minutes)).toEqual([30, 0, 45, 0, 0, 0, 30]);
    expect(p.bars.map((b) => b.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(p.bars.find((b) => b.current)!.label).toBe('Thu');
    expect(Object.keys(p).filter((k) => /streak|grace|rest/i.test(k))).toEqual([]);
  });

  it('week boundary follows the local clock, across DST changes', async () => {
    const g = await guest(app);
    const svc = app.get(ProgressService);
    // Berlin: clocks go back on Sun 2026-10-25 → the Mon 26th 00:30 local belongs to the NEXT week
    const before = await svc.week(g.me.id, 'Europe/Berlin', new Date('2026-10-25T22:30:00Z')); // Sun 23:30 local
    const after = await svc.week(g.me.id, 'Europe/Berlin', new Date('2026-10-25T23:30:00Z')); // Mon 00:30 local
    expect([before.from, before.to, before.today]).toEqual(['2026-10-19', '2026-10-25', '2026-10-25']);
    expect([after.from, after.to, after.today]).toEqual(['2026-10-26', '2026-11-01', '2026-10-26']);
    // spring forward in Berlin: Sun 2026-03-29
    const spring = await svc.week(g.me.id, 'Europe/Berlin', new Date('2026-03-29T00:30:00Z'));
    expect([spring.from, spring.to]).toEqual(['2026-03-23', '2026-03-29']);
    const ny = await svc.week(g.me.id, 'America/New_York', new Date('2026-11-02T04:30:00Z')); // Sun Nov 1 23:30 local (after fall back)
    expect([ny.from, ny.to, ny.today]).toEqual(['2026-10-26', '2026-11-01', '2026-11-01']);
    const syd = await svc.week(g.me.id, 'Australia/Sydney', new Date('2026-10-03T14:30:00Z')); // Sun Oct 4 01:30 → DST starts 02:00 that day
    expect([syd.from, syd.to]).toEqual(['2026-09-28', '2026-10-04']);
    const tokyo = await svc.week(g.me.id, 'Asia/Tokyo', new Date('2026-10-04T15:30:00Z')); // Mon Oct 5 00:30 JST
    expect([tokyo.from, tokyo.today]).toEqual(['2026-10-05', '2026-10-05']);
    // the stored local_date is what counts: a meditation on 2026-10-26 (local) is not in the week ending the 25th
    await day(g.me.id, '2026-10-26', 20, 1);
    expect((await svc.progress(g.me.id, 'Europe/Berlin', 'week', new Date('2026-10-25T22:30:00Z'))).minutes).toBe(0);
    expect((await svc.progress(g.me.id, 'Europe/Berlin', 'week', new Date('2026-10-25T23:30:00Z'))).minutes).toBe(20);
  });

  it('month (by week), year (by month), lifetime (by month)', async () => {
    const g = await guest(app);
    const svc = app.get(ProgressService);
    await q(`INSERT INTO user_stats (user_id, first_meditation_at) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET first_meditation_at = excluded.first_meditation_at`, [g.me.id, '2026-07-15T08:00:00Z']);
    for (const [d, m, n, gr] of [['2026-07-15', 40, 4, 1], ['2026-08-02', 60, 3, 0], ['2026-09-10', 100, 6, 2], ['2026-10-01', 20, 1, 0], ['2026-10-09', 50, 2, 1], ['2026-10-30', 10, 1, 0]] as const) await day(g.me.id, d, m, n, gr);
    const now = new Date('2026-10-12T09:00:00Z');
    const month = await svc.progress(g.me.id, 'UTC', 'month', now);
    expect(month).toMatchObject({ from: '2026-10-01', to: '2026-10-31', minutes: 80, meditations: 4, together: 1, average: 20 });
    expect(month.bars.map((b) => [b.label, b.minutes])).toEqual([['Week 1', 20], ['Week 2', 50], ['Week 3', 0], ['Week 4', 0], ['Week 5', 10]]);
    expect(month.bars.find((b) => b.current)!.label).toBe('Week 2');
    const year = await svc.progress(g.me.id, 'UTC', 'year', now);
    expect(year).toMatchObject({ from: '2026-01-01', to: '2026-12-31', minutes: 280, meditations: 17, together: 4 });
    expect(year.bars).toHaveLength(10); // Jan … Oct
    expect(year.bars.slice(6).map((b) => [b.label, b.minutes])).toEqual([['Jul', 40], ['Aug', 60], ['Sep', 100], ['Oct', 80]]);
    expect(year.bars[9]!.current).toBe(true);
    const life = await svc.progress(g.me.id, 'UTC', 'all', now);
    expect(life).toMatchObject({ from: '2026-07-15', to: '2026-10-12', minutes: 270, meditations: 16 });
    expect(life.bars.map((b) => b.label)).toEqual(['Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026']);
    const empty = await svc.progress((await guest(app)).me.id, 'UTC', 'all', now);
    expect(empty).toMatchObject({ minutes: 0, meditations: 0, average: 0, daysMeditated: 0 });
    expect(empty.bars).toHaveLength(1);
  });

  it('GET /v1/me/progress: validates the period, uses my time zone, is private', async () => {
    const g = await guest(app);
    await tzOf(g.me.id, 'Pacific/Kiritimati'); // UTC+14
    await h().post('/v1/meditations', med({}, 600), { token: g.accessToken });
    await drain();
    const r = await h().get('/v1/me/progress?period=week', { token: g.accessToken });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, max-age=0');
    expect(r.body.data).toMatchObject({ period: 'week', minutes: 10, meditations: 1, daysMeditated: 1 });
    expect(r.body.data.daysThisWeek).toHaveLength(7);
    for (const p of ['month', 'year', 'all']) expect((await h().get(`/v1/me/progress?period=${p}`, { token: g.accessToken })).status).toBe(200);
    expect((await h().get('/v1/me/progress', { token: g.accessToken })).body.data.period).toBe('week'); // default
    expect((await h().get('/v1/me/progress?period=decade', { token: g.accessToken })).status).toBe(400);
    expect((await h().get('/v1/me/progress')).status).toBe(401);
  });
});

describe('P4 performance (in-process, excluding network)', () => {
  it('POST /v1/meditations p95 < 150 ms; progress p95 < 120 ms', async () => {
    const g = await guest(app);
    const pctl = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
    const rec: number[] = [], prog: number[] = [];
    for (let i = 0; i < 120; i++) {
      if (i % 40 === 39) await clearRates();
      let t = process.hrtime.bigint();
      const r = await h().post('/v1/meditations', med({}, 200, 1 + (i % 50)), { token: g.accessToken });
      rec.push(Number(process.hrtime.bigint() - t) / 1e6); expect(r.status).toBe(201);
      t = process.hrtime.bigint();
      await h().get('/v1/me/progress?period=month', { token: g.accessToken });
      prog.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    console.log('P4 latency (ms)', JSON.stringify({ record: { p50: pctl(rec, 0.5), p95: pctl(rec, 0.95) }, progress: { p50: pctl(prog, 0.5), p95: pctl(prog, 0.95) } }));
    expect(pctl(rec, 0.95)).toBeLessThan(150);
    expect(pctl(prog, 0.95)).toBeLessThan(120);
    await drain();
  });
});
