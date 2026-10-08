import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { fromZonedTime } from 'date-fns-tz';
import type Redis from 'ioredis';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { K, REDIS } from '../src/infra/redis';
import { QUEUES, QueueService } from '../src/jobs/queues';
import { WorkerRunner } from '../src/jobs/workers';
import { GroupService } from '../src/modules/today/group.service';
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
const med = (over: Record<string, unknown> = {}, sec = 600) => ({ id: uuid(), kind: 'solo', startedAt: new Date(Date.now() - 5 * 60_000 - sec * 1000).toISOString(), endedAt: ago(5), durationSec: sec, completed: true, ...over });
/** Cached Today / MOTD payloads and config, so a changed setting is visible at once. */
const dropCaches = async () => { const ks = await redis.keys('today:*'); const ms = await redis.keys('motd:*'); const cs = await redis.keys('config:*'); const all = [...ks, ...ms, ...cs, 'offer:founding']; if (all.length) await redis.del(...all); };
const setConfig = async (key: string, patch: Record<string, unknown>) => { await q(`UPDATE app_config SET value = value || $2::jsonb, version = version + 1 WHERE key=$1`, [key, JSON.stringify(patch)]); await dropCaches(); };

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  redis = app.get(REDIS);
  runner = app.get(WorkerRunner); runner.start();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
beforeEach(async () => { await clearRates(); await dropCaches(); await redis.del(K.aggCountry); });
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P4 GET /v1/bootstrap', () => {
  it('one call with everything the app needs on launch', async () => {
    const g = await member(app, db);
    const r = await h().get('/v1/bootstrap', { token: g.accessToken });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, max-age=0');
    const d = r.body.data;
    expect(Math.abs(d.serverTime - Date.now())).toBeLessThan(5000);
    expect(d).toMatchObject({
      updateRequired: false, maintenance: false,
      me: { id: g.me.id, isGuest: true, timezone: 'Europe/Berlin', theme: 'dark', reminder: { enabled: true, time: '07:00' }, groupWarning: false, showCountry: true },
      entitlement: { active: true, productId: 'wehum_annual', periodType: 'trial', willRenew: false, isFounding: false },
      features: { challenges: false, gratitude: false, breathwork: false, milestones: false, intent: false },
      today: { emptyRoomThreshold: 10, freeHomePick: 'random', showDailyMessage: false },
      group: { startUtc: '16:00', lengthMin: 30, lobbyOpenMin: 15, reminderMin: 10 },
      founding: { open: true, left: 1000, cap: 1000 },
      sos: { title: 'How can I help?', help: { contactEmail: 'hello@wehum.app' } },
      socket: { url: 'ws://localhost:3000', namespace: '/live' },
    });
    expect(d.catalogVersion).toBe((await h().get('/v1/catalog', { token: g.accessToken })).body.meta.version);
    expect(d.configVersion).toBeGreaterThan(0);
    expect(Object.keys(d.me)).not.toEqual(expect.arrayContaining(['email', 'providers', 'createdAt'])); // minimal profile
    expect((await h().get('/v1/bootstrap')).status).toBe(401);
  });

  it('free user: inactive entitlement; founding counter reflects the offer', async () => {
    const g = await guest(app);
    expect((await h().get('/v1/bootstrap', { token: g.accessToken })).body.data.entitlement).toMatchObject({ active: false, productId: null, periodType: null });
    await q(`UPDATE offers SET taken = 1000 WHERE id='founding'`); await dropCaches();
    expect((await h().get('/v1/bootstrap', { token: g.accessToken })).body.data.founding).toEqual({ open: false, left: 0, cap: 1000 });
    await q(`UPDATE offers SET taken = 786, open = true WHERE id='founding'`); await dropCaches();
    expect((await h().get('/v1/bootstrap', { token: g.accessToken })).body.data.founding).toEqual({ open: true, left: 214, cap: 1000 });
    await q(`UPDATE offers SET open = false WHERE id='founding'`); await dropCaches();
    expect((await h().get('/v1/bootstrap', { token: g.accessToken })).body.data.founding.open).toBe(false);
    await q(`UPDATE offers SET taken = 0, open = true WHERE id='founding'`); await dropCaches();
  });

  it('ETag: 304 until something changes (the clock is not part of it)', async () => {
    const g = await guest(app);
    const a = await h().get('/v1/bootstrap', { token: g.accessToken });
    await new Promise((r) => setTimeout(r, 20));
    const b = await h().get('/v1/bootstrap', { token: g.accessToken, headers: { 'if-none-match': a.headers.etag as string } });
    expect(b.status).toBe(304);
    expect(b.body).toBe('');
    await h().patch('/v1/me', { theme: 'light' }, { token: g.accessToken });
    const c = await h().get('/v1/bootstrap', { token: g.accessToken, headers: { 'if-none-match': a.headers.etag as string } });
    expect(c.status).toBe(200);
    expect(c.body.data.me.theme).toBe('light');
    expect(c.headers.etag).not.toBe(a.headers.etag);
    const before = c.body.data.configVersion;
    await setConfig('today', { emptyRoomThreshold: 12 });
    const d = await h().get('/v1/bootstrap', { token: g.accessToken, headers: { 'if-none-match': c.headers.etag as string } });
    expect(d.status).toBe(200);
    expect(d.body.data.configVersion).toBe(before + 1);
    expect(d.body.data.today.emptyRoomThreshold).toBe(12);
    await setConfig('today', { emptyRoomThreshold: 10 });
  });

  it('exempt from the version gate: old apps get updateRequired, other routes answer 426', async () => {
    const g = await guest(app);
    await setConfig('main', { minVersion: { ios: '2.0.0', android: '1.0.0' } });
    const old = await h().get('/v1/bootstrap', { token: g.accessToken, headers: { 'x-app-version': '1.9.9', 'x-platform': 'ios' } });
    expect(old.status).toBe(200);
    expect(old.body.data.updateRequired).toBe(true);
    expect((await h().get('/v1/today', { token: g.accessToken, headers: { 'x-app-version': '1.9.9', 'x-platform': 'ios' } })).status).toBe(426);
    expect((await h().get('/v1/bootstrap', { token: g.accessToken, headers: { 'x-app-version': '2.0.0', 'x-platform': 'ios' } })).body.data.updateRequired).toBe(false);
    expect((await h().get('/v1/bootstrap', { token: g.accessToken, headers: { 'x-app-version': '1.0.0', 'x-platform': 'android' } })).body.data.updateRequired).toBe(false);
    await setConfig('main', { minVersion: { ios: '1.0.0', android: '1.0.0' } });
  });

  it('update prompt: below latestVersion but above minVersion → available (dismissible) with the store link; below min → required', async () => {
    const g = await guest(app);
    await setConfig('main', { latestVersion: { ios: '1.5.0', android: '1.5.0' }, storeUrls: { ios: 'https://apps.apple.com/app/id1', android: 'https://play.google.com/store/apps/details?id=app.wehum.meditation' } });
    const get = async (version: string, platform: string) => (await h().get('/v1/bootstrap', { token: g.accessToken, headers: { 'x-app-version': version, 'x-platform': platform } })).body.data;
    expect((await get('1.2.0', 'ios')).update).toEqual({ required: false, available: true, latest: '1.5.0', storeUrl: 'https://apps.apple.com/app/id1' });
    expect((await get('1.5.0', 'ios')).update).toMatchObject({ required: false, available: false });
    expect((await get('1.4.9', 'android')).update).toMatchObject({ available: true, storeUrl: expect.stringContaining('play.google.com') });
    await setConfig('main', { minVersion: { ios: '1.3.0', android: '1.0.0' } });
    expect((await get('1.2.0', 'ios')).update).toMatchObject({ required: true, available: false }); // one prompt at a time: the blocking one
    await setConfig('main', { minVersion: { ios: '1.0.0', android: '1.0.0' }, latestVersion: null, storeUrls: null });
    expect((await get('1.2.0', 'ios')).update).toEqual({ required: false, available: false, latest: null, storeUrl: null });
  });

  it('maintenance: bootstrap still answers (with the flag), other app routes 503', async () => {
    const g = await guest(app);
    await setConfig('main', { maintenance: true });
    expect((await h().get('/v1/bootstrap', { token: g.accessToken })).body.data.maintenance).toBe(true);
    const t = await h().get('/v1/today', { token: g.accessToken });
    expect(t.status).toBe(503);
    expect(t.body.error.code).toBe('MAINTENANCE');
    expect((await h().get('/v1/time')).status).toBe(200);
    await setConfig('main', { maintenance: false });
    expect((await h().get('/v1/today', { token: g.accessToken })).status).toBe(200);
  });
});

describe('P4 GET /v1/today', () => {
  it('free user: MOTD, honest live line, group, a free pick, no member-only data', async () => {
    const g = await guest(app);
    const r = await h().get('/v1/today', { token: g.accessToken });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.date).toBe(dayIso());
    expect(d.motd).toMatchObject({ date: dayIso(), lengths: [10, 30, 45], access: 'premium', fallback: false, practicedToday: expect.any(Number) });
    expect(d.live).toEqual({ total: 0, countries: 0, quiet: true, meditatedToday: 0 }); // nobody is meditating: never invented
    expect(d.group).toMatchObject({ lengthMin: 30, state: expect.stringMatching(/^(scheduled|lobby|live|ended)$/), waiting: 0, startsAt: `${dayIso()}T16:00:00.000Z` });
    expect(d.freePick).toMatchObject({ sessionId: expect.any(String), title: expect.any(String), youtubeId: expect.stringMatching(/^seedYT/), durationSec: expect.any(Number) });
    expect(d.program).toBeNull();
    expect(d.progress).toEqual({ minutesWeek: 0, meditationsWeek: 0, daysThisWeek: [false, false, false, false, false, false, false] });
    expect(d.dailyMessage).toBeNull();
    expect(JSON.stringify(d)).not.toMatch(/freeItems|freeHomePick|mediaId|storageKey/);
  });

  it('member: no free pick; daily message only when switched on', async () => {
    const m = await member(app, db);
    const off = (await h().get('/v1/today', { token: m.accessToken })).body.data;
    expect(off.freePick).toBeNull();
    expect(off.dailyMessage).toBeNull();
    await setConfig('today', { showDailyMessage: true });
    const on = (await h().get('/v1/today', { token: m.accessToken })).body.data;
    expect(on.dailyMessage).toMatchObject({ date: expect.any(String), title: expect.any(String), type: expect.stringMatching(/^(audio|text|video)$/) });
    const free = await guest(app);
    expect((await h().get('/v1/today', { token: free.accessToken })).body.data.dailyMessage).toBeNull(); // members only
    await setConfig('today', { showDailyMessage: false });
  });

  it('free pick: stable per user and day, spread across users; "newest" is the latest item', async () => {
    const picks: string[] = [];
    for (let i = 0; i < 12; i++) {
      const g = await guest(app);
      const a = (await h().get('/v1/today', { token: g.accessToken })).body.data.freePick.sessionId;
      await dropCaches();
      const b = (await h().get('/v1/today', { token: g.accessToken })).body.data.freePick.sessionId;
      expect(b).toBe(a); // reopening the app does not reshuffle
      picks.push(a);
    }
    expect(new Set(picks).size).toBeGreaterThan(1);
    await setConfig('today', { freeHomePick: 'newest' });
    const newest = (await q<{ id: string }>(`SELECT id FROM sessions WHERE access='free' AND type='youtube' AND status='live' ORDER BY publish_at DESC, id ASC LIMIT 1`))[0]!.id;
    for (let i = 0; i < 3; i++) expect((await h().get('/v1/today', { token: (await guest(app)).accessToken })).body.data.freePick.sessionId).toBe(newest);
    await setConfig('today', { freeHomePick: 'random' });
  });

  it('date must be the local date: yesterday, today and tomorrow are fine', async () => {
    const g = await guest(app);
    for (const n of [-1, 0, 1]) expect((await h().get(`/v1/today?date=${dayIso(n)}`, { token: g.accessToken })).body.data.date).toBe(dayIso(n));
    for (const bad of [dayIso(2), dayIso(-2), '2026-02-30', 'today', '20261005']) {
      const r = await h().get(`/v1/today?date=${bad}`, { token: g.accessToken });
      expect(r.status, bad).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect((await h().get('/v1/today')).status).toBe(401);
  });

  it('no MOTD for the date → most-played live premium meditation, flagged as fallback', async () => {
    const g = await guest(app);
    const star = (await q<{ id: string; title: string }>(`SELECT id, title FROM sessions WHERE status='live' AND access='premium' AND NOT is_sos AND type<>'youtube' ORDER BY slug LIMIT 1 OFFSET 9`))[0]!;
    await q(`UPDATE sessions SET plays = 5000 WHERE id=$1`, [star.id]);
    await q(`DELETE FROM motd_days WHERE date=$1`, [dayIso(1)]); await dropCaches();
    const d = (await h().get(`/v1/today?date=${dayIso(1)}`, { token: g.accessToken })).body.data;
    expect(d.motd).toMatchObject({ fallback: true, sessionId: star.id, title: star.title, lengths: [], access: 'premium', practicedToday: 0 });
    expect(d.motd.cover).toEqual(expect.objectContaining({ url: expect.any(String) }));
    const ok = (await h().get('/v1/today', { token: g.accessToken })).body.data;
    expect(ok.motd.fallback).toBe(false);
    await q(`UPDATE sessions SET plays = 0 WHERE id=$1`, [star.id]);
  });

  it('live line follows the empty-room rule from the real presence numbers', async () => {
    const g = await guest(app);
    await redis.hset(K.aggCountry, { DE: 300, US: 150, PK: 5, XX: 0 });
    await redis.set(K.vibration, '64');
    const busy = (await h().get('/v1/today', { token: g.accessToken })).body.data.live;
    expect(busy).toEqual({ total: 455, countries: 3, quiet: false, meditatedToday: 0 });
    await dropCaches();
    await redis.hset(K.aggCountry, { DE: 2, US: 1, PK: 1 });
    await redis.set(K.medsToday(dayIso()), '1280');
    const quiet = (await h().get('/v1/today', { token: g.accessToken })).body.data.live;
    expect(quiet).toEqual({ total: 4, countries: 3, quiet: true, meditatedToday: 1280 }); // quiet → the app shows "meditated today"
    await setConfig('today', { emptyRoomThreshold: 3 });
    expect((await h().get('/v1/today', { token: g.accessToken })).body.data.live.quiet).toBe(false); // threshold is a CMS setting
    await setConfig('today', { emptyRoomThreshold: 10 });
    await redis.del(K.medsToday(dayIso()), K.vibration);
  });

  it('GET /v1/live: same numbers for when the socket is down', async () => {
    const g = await guest(app);
    await redis.hset(K.aggCountry, { DE: 12, FR: 7, BR: 3 });
    await redis.set(K.vibration, '41');
    const r = await h().get('/v1/live', { token: g.accessToken });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.body.data).toMatchObject({ total: 22, countries: 3, quiet: false, vibration: 41, top: [{ c: 'DE', n: 12 }, { c: 'FR', n: 7 }, { c: 'BR', n: 3 }], line: { quiet: false, number: 22, label: 'meditating now' } });
    expect(r.body.data.at).toBeGreaterThan(Date.now() - 5000);
    await redis.del(K.vibration);
    expect((await h().get('/v1/live')).status).toBe(401);
    expect((await h().get('/v1/live?date=nope', { token: g.accessToken })).status).toBe(400);
  });

  it('GET /v1/admin/public/live: the CMS sign-in page gets two totals without a token, and nothing else', async () => {
    await redis.hset(K.aggCountry, { DE: 12, FR: 7, BR: 3 });
    await redis.set(K.medsToday(dayIso()), '3180');
    const r = await h().get('/v1/admin/public/live');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=10');
    expect(Object.keys(r.body.data).sort()).toEqual(['at', 'meditatedToday', 'meditatingNow']); // no countries, no vibration
    expect(r.body.data).toMatchObject({ meditatedToday: 3180, meditatingNow: 22 });
    await redis.del(K.medsToday(dayIso()));
  });

  it('ETag/304, and it changes when my progress changes', async () => {
    const g = await guest(app);
    const a = await h().get('/v1/today', { token: g.accessToken });
    const same = await h().get('/v1/today', { token: g.accessToken, headers: { 'if-none-match': a.headers.etag as string } });
    expect(same.status).toBe(304);
    await h().post('/v1/meditations', med(), { token: g.accessToken });
    await drain();
    const after = await h().get('/v1/today', { token: g.accessToken, headers: { 'if-none-match': a.headers.etag as string } });
    expect(after.status).toBe(200);
    expect(after.body.data.progress).toMatchObject({ minutesWeek: 10, meditationsWeek: 1 });
    expect(after.body.data.progress.daysThisWeek.filter(Boolean)).toHaveLength(1);
  });
});

describe('P4 group meditation timing', () => {
  const at = (date: string, time: string) => Date.parse(`${date}T${time}:00Z`);

  it('scheduled → lobby → live → ended around the configured UTC start', async () => {
    const svc = app.get(GroupService), date = '2026-10-05';
    const state = async (t: string) => (await svc.forDate(date, at(date, t))).state;
    expect(await state('15:44')).toBe('scheduled');
    expect(await state('15:45')).toBe('lobby'); // the lobby opens 15 min before 16:00
    expect(await state('15:59')).toBe('lobby');
    expect(await state('16:00')).toBe('live');
    expect(await state('16:29')).toBe('live');
    expect(await state('16:30')).toBe('ended');
    const g = await svc.forDate(date, at(date, '12:00'));
    expect(g).toMatchObject({ startsAt: '2026-10-05T16:00:00.000Z', endsAt: '2026-10-05T16:30:00.000Z', lobbyOpensAt: '2026-10-05T15:45:00.000Z', lengthMin: 30, reminderMin: 10 });
  });

  it('a per-date override beats the default; the settings change takes effect at once', async () => {
    const svc = app.get(GroupService), today = dayIso();
    await q(`UPDATE motd_days SET group_start_utc='18:30', group_length_min=45 WHERE date=$1`, [today]); await dropCaches();
    const g = await svc.forDate(today, at(today, '12:00'));
    expect([g.startsAt, g.endsAt, g.lengthMin]).toEqual([`${today}T18:30:00.000Z`, `${today}T19:15:00.000Z`, 45]);
    expect(g.sessionId).toEqual(expect.any(String));
    await q(`UPDATE motd_days SET group_start_utc=NULL, group_length_min=NULL WHERE date=$1`, [today]);
    await setConfig('group', { startUtc: '09:15', lobbyOpenMin: 30 });
    const c = await svc.forDate(today, at(today, '12:00'));
    expect([c.startsAt, c.lobbyOpensAt]).toEqual([`${today}T09:15:00.000Z`, `${today}T08:45:00.000Z`]);
    await setConfig('group', { startUtc: '16:00', lobbyOpenMin: 15 });
  });

  it('waiting counts only fresh lobby entries (never faked)', async () => {
    const svc = app.get(GroupService), date = dayIso(), now = Date.now();
    await redis.del(K.lobby(date));
    await redis.zadd(K.lobby(date), now - 1000, 'u1', now - 30_000, 'u2', now - 89_000, 'u3', now - 200_000, 'stale');
    expect((await svc.forDate(date, now)).waiting).toBe(3);
    await redis.del(K.lobby(date));
    expect((await svc.forDate(date, now)).waiting).toBe(0);
  });

  it('next(): today while it is not over, otherwise tomorrow; GET /v1/group/next', async () => {
    const svc = app.get(GroupService), date = '2026-10-05';
    expect((await svc.next(at(date, '15:00'))).date).toBe(date);
    expect((await svc.next(at(date, '16:10'))).date).toBe(date); // running right now
    const after = await svc.next(at(date, '16:30'));
    expect([after.date, after.startsAt, after.state]).toEqual(['2026-10-06', '2026-10-06T16:00:00.000Z', 'scheduled']);
    const g = await guest(app);
    const r = await h().get('/v1/group/next', { token: g.accessToken });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ startsAt: expect.stringMatching(/T\d\d:\d\d:00\.000Z$/), lengthMin: 30, state: expect.any(String) });
    expect((await h().get('/v1/group/next')).status).toBe(401);
  });
});

describe('P4 programs (member)', () => {
  const program = async (rule = 'next_day_0700') => {
    const id = (await q<{ id: string }>(`SELECT id FROM programs WHERE slug='7-days-of-calm'`))[0]!.id;
    await q(`UPDATE programs SET unlock_rule=$2, status='live' WHERE id=$1`, [id, rule]); await dropCaches();
    const days = await q<{ day: number; session_id: string }>(`SELECT day, session_id FROM program_days WHERE program_id=$1 ORDER BY day`, [id]);
    return { id, days };
  };
  const sit = (token: string, sessionId: string) => h().post('/v1/meditations', med({ sessionId, kind: 'program' }, 600), { token });
  const complete = (token: string, id: string, day: number) => h().post(`/v1/programs/${id}/days/${day}/complete`, {}, { token });
  /** Starts the program and moves the start an hour back, so the helper's meditations (ended 5 min ago) happened after it. */
  const startedHourAgo = async (token: string, userId: string, id: string) => {
    await h().post(`/v1/programs/${id}/start`, {}, { token });
    await q(`UPDATE program_progress SET started_at = now() - interval '1 hour' WHERE user_id=$1 AND program_id=$2`, [userId, id]);
  };

  it('start: members only, idempotent, 404 for unknown/draft, needs days', async () => {
    const { id } = await program();
    const free = await guest(app), m = await member(app, db);
    expect((await h().post(`/v1/programs/${id}/start`, {}, { token: free.accessToken })).body.error.code).toBe('PREMIUM_REQUIRED');
    expect((await h().post(`/v1/programs/${id}/start`)).status).toBe(401);
    expect((await h().post(`/v1/programs/${uuid()}/start`, {}, { token: m.accessToken })).status).toBe(404);
    expect((await h().post('/v1/programs/nope/start', {}, { token: m.accessToken })).status).toBe(400);
    const s1 = await h().post(`/v1/programs/${id}/start`, {}, { token: m.accessToken });
    expect(s1.status).toBe(200);
    expect(s1.body.data).toMatchObject({ programId: id, currentDay: 1, completedDays: [], days: 7, completedAt: null, unlockAt: null });
    const s2 = await h().post(`/v1/programs/${id}/start`, {}, { token: m.accessToken });
    expect(s2.body.data.startedAt).toBe(s1.body.data.startedAt); // starting twice keeps the progress
    await q(`UPDATE programs SET status='draft' WHERE id=$1`, [id]);
    expect((await h().post(`/v1/programs/${id}/start`, {}, { token: m.accessToken })).status).toBe(404);
    await q(`UPDATE programs SET status='live' WHERE id=$1`, [id]);
    const empty = (await q<{ id: string }>(`INSERT INTO programs (id, slug, title, status) VALUES ($1,$2,'Empty','live') RETURNING id`, [uuid(), `empty-${Math.random().toString(36).slice(2, 6)}`]))[0]!.id;
    expect((await h().post(`/v1/programs/${empty}/start`, {}, { token: m.accessToken })).body.error.code).toBe('INVALID_STATE');
  });

  it('one day at a time: needs the meditation, opens the next morning at 07:00 local, no skipping', async () => {
    const { id, days } = await program();
    const m = await member(app, db);
    await q(`UPDATE users SET timezone='Asia/Kolkata' WHERE id=$1`, [m.me.id]);
    expect((await complete(m.accessToken, id, 1)).body.error.code).toBe('INVALID_STATE'); // not started
    await startedHourAgo(m.accessToken, m.me.id, id);
    const early = await complete(m.accessToken, id, 1);
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('MEDITATION_REQUIRED');
    expect((await complete(m.accessToken, id, 2)).body.error.code).toBe('INVALID_STATE'); // locked, out of order
    expect((await complete(m.accessToken, id, 8)).status).toBe(404);
    expect((await complete(m.accessToken, id, 0)).status).toBe(400);

    await sit(m.accessToken, days[1]!.session_id); // the wrong session does not count for day 1
    expect((await complete(m.accessToken, id, 1)).body.error.code).toBe('MEDITATION_REQUIRED');
    await h().post('/v1/meditations', med({ sessionId: days[0]!.session_id, kind: 'program' }, 100), { token: m.accessToken }); // too short to count
    expect((await complete(m.accessToken, id, 1)).body.error.code).toBe('MEDITATION_REQUIRED');
    await sit(m.accessToken, days[0]!.session_id);
    const d1 = await complete(m.accessToken, id, 1);
    expect(d1.status).toBe(200);
    expect(d1.body.data).toMatchObject({ currentDay: 2, completedDays: [1], completedAt: null, days: 7 });
    const lastDone = new Date((await q<{ t: string }>(`SELECT last_day_completed_at t FROM program_progress WHERE user_id=$1`, [m.me.id]))[0]!.t);
    const localDay = lastDone.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const nextDay = new Date(Date.parse(`${localDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(d1.body.data.unlockAt).toBe(fromZonedTime(`${nextDay}T07:00:00`, 'Asia/Kolkata').toISOString());

    expect((await complete(m.accessToken, id, 1)).body.data.completedDays).toEqual([1]); // idempotent
    const locked = await complete(m.accessToken, id, 2);
    expect(locked.status).toBe(422);
    expect(locked.body.error).toMatchObject({ code: 'INVALID_STATE', details: { unlockAt: d1.body.data.unlockAt } });
    expect((await complete(m.accessToken, id, 3)).body.error.code).toBe('INVALID_STATE'); // no skipping ahead

    // the card on Today shows where I am and when it opens
    const card = (await h().get('/v1/today', { token: m.accessToken })).body.data.program;
    expect(card).toEqual({ id, title: '7 Days of Calm', day: 2, days: 7, unlockAt: d1.body.data.unlockAt });

    // time passes: day 2 opens, but only a meditation after the opening counts
    await q(`UPDATE program_progress SET last_day_completed_at = now() - interval '2 days' WHERE user_id=$1`, [m.me.id]);
    await q(`UPDATE meditations SET started_at = started_at - interval '3 days', ended_at = ended_at - interval '3 days' WHERE user_id=$1 AND session_id=$2`, [m.me.id, days[1]!.session_id]); // that early sit predates the opening
    expect((await complete(m.accessToken, id, 2)).body.error.code).toBe('MEDITATION_REQUIRED'); // nothing meditated since day 2 opened
    await sit(m.accessToken, days[1]!.session_id);
    expect((await complete(m.accessToken, id, 2)).body.data).toMatchObject({ currentDay: 3, completedDays: [1, 2], unlockAt: expect.any(String) });
  });

  it('finishing the last day completes the program; starting again resets it', async () => {
    const { id, days } = await program();
    const m = await member(app, db);
    await startedHourAgo(m.accessToken, m.me.id, id);
    let last;
    for (const d of days) {
      await q(`UPDATE program_progress SET last_day_completed_at = now() - interval '2 days' WHERE user_id=$1 AND last_day_completed_at IS NOT NULL`, [m.me.id]);
      await sit(m.accessToken, d.session_id);
      last = await complete(m.accessToken, id, d.day);
      expect(last.status, `day ${d.day}`).toBe(200);
    }
    expect(last!.body.data).toMatchObject({ currentDay: 7, completedDays: [1, 2, 3, 4, 5, 6, 7], completedAt: expect.any(String), unlockAt: null });
    expect((await h().get('/v1/today', { token: m.accessToken })).body.data.program).toBeNull(); // finished programs leave the card
    expect((await h().get(`/v1/programs/${id}`, { token: m.accessToken })).body.data.progress.completedAt).not.toBeNull();
    const again = await h().post(`/v1/programs/${id}/start`, {}, { token: m.accessToken });
    expect(again.body.data).toMatchObject({ currentDay: 1, completedDays: [], completedAt: null });
    expect((await h().get('/v1/today', { token: m.accessToken })).body.data.program).toMatchObject({ day: 1, days: 7 });
  });

  it('"immediate" programs do not wait between days', async () => {
    const { id, days } = await program('immediate');
    const m = await member(app, db);
    await startedHourAgo(m.accessToken, m.me.id, id);
    for (const d of days.slice(0, 3)) {
      await sit(m.accessToken, d.session_id);
      const r = await complete(m.accessToken, id, d.day);
      expect(r.status).toBe(200);
      expect(r.body.data.unlockAt).toBeNull();
    }
    await program('next_day_0700');
  });
});

describe('P4 recipes (Build your own)', () => {
  const blocks = async () => ({
    opening: (await q<{ id: string }>(`SELECT id FROM sound_blocks WHERE kind='opening' ORDER BY "order" LIMIT 1`))[0]!.id,
    sound: (await q<{ id: string }>(`SELECT id FROM sound_blocks WHERE kind='sound' ORDER BY "order" LIMIT 1`))[0]!.id,
    core: (await q<{ id: string }>(`SELECT id FROM sound_blocks WHERE kind='core' ORDER BY "order" LIMIT 1`))[0]!.id,
    loop: (await q<{ id: string }>(`SELECT id FROM sound_blocks WHERE kind='loop' ORDER BY "order" LIMIT 1`))[0]!.id,
  });
  const base = (over: object = {}) => ({ name: 'Sunday OM', lengthMin: 15, ...over });

  it('members only', async () => {
    const free = await guest(app), m = await member(app, db);
    const rid = (await h().post('/v1/recipes', base(), { token: m.accessToken })).body.data.id;
    for (const [method, url] of [['get', '/v1/recipes'], ['post', '/v1/recipes'], ['patch', `/v1/recipes/${rid}`], ['del', `/v1/recipes/${rid}`], ['post', `/v1/recipes/${rid}/share`]] as const) {
      const r = await (h()[method] as (u: string, ...a: unknown[]) => ReturnType<ReturnType<typeof http>['get']>)(url, ...(method === 'get' || method === 'del' ? [{ token: free.accessToken }] : [base(), { token: free.accessToken }]));
      expect(r.body.error.code, `${method} ${url}`).toBe('PREMIUM_REQUIRED');
    }
    expect((await h().get('/v1/recipes')).status).toBe(401);
  });

  it('create with defaults, list (newest edit first), patch, delete', async () => {
    const m = await member(app, db), b = await blocks();
    const full = { name: '  Evening reset ', lengthMin: 20, openingId: b.opening, soundId: b.sound, soundLevel: 35, texture: 'rich', bells: { start: true, end: false, intervalMin: 5 }, blocks: [{ type: 'block', blockId: b.loop, count: 3 }, { type: 'silence' }, { type: 'block', blockId: b.core }] };
    const a = await h().post('/v1/recipes', full, { token: m.accessToken });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ name: 'Evening reset', lengthMin: 20, openingId: b.opening, soundId: b.sound, soundLevel: 35, texture: 'rich', shareSlug: null, shareUrl: null });
    expect(a.body.data.blocks).toEqual([{ type: 'block', blockId: b.loop, count: 3 }, { type: 'silence' }, { type: 'block', blockId: b.core, count: 1 }]);
    const d = await h().post('/v1/recipes', base({ name: 'Quick' }), { token: m.accessToken });
    expect(d.body.data).toMatchObject({ soundLevel: 50, texture: 'simple', bells: { start: true, end: true, intervalMin: 0 }, blocks: [], openingId: null, soundId: null });
    await new Promise((r) => setTimeout(r, 15));
    const p = await h().patch(`/v1/recipes/${a.body.data.id}`, { name: 'Evening reset v2', soundLevel: 80 }, { token: m.accessToken });
    expect(p.body.data).toMatchObject({ name: 'Evening reset v2', soundLevel: 80, lengthMin: 20 });
    const list = await h().get('/v1/recipes', { token: m.accessToken });
    expect(list.body.data.map((r: { name: string }) => r.name)).toEqual(['Evening reset v2', 'Quick']);
    expect((await h().del(`/v1/recipes/${d.body.data.id}`, { token: m.accessToken })).status).toBe(204);
    expect((await h().del(`/v1/recipes/${d.body.data.id}`, { token: m.accessToken })).status).toBe(404);
    expect((await h().get('/v1/recipes', { token: m.accessToken })).body.data).toHaveLength(1);
  });

  it('validation: lengths, shapes, and sounds that do not exist or are the wrong kind', async () => {
    const m = await member(app, db), b = await blocks();
    const post = (o: object) => h().post('/v1/recipes', base(o), { token: m.accessToken });
    for (const bad of [{ lengthMin: 4 }, { lengthMin: 61 }, { name: '  ' }, { name: 'x'.repeat(61) }, { soundLevel: 101 }, { texture: 'loud' }, { bells: { start: true, intervalMin: 61 } }, { color: 'red' },
      { blocks: Array.from({ length: 31 }, () => ({ type: 'silence' })) }, { blocks: [{ type: 'block', blockId: b.loop, count: 22 }] }, { blocks: [{ type: 'silence', count: 2 }] }, { blocks: [{ type: 'om' }] }]) {
      expect((await post(bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    const missing = await post({ openingId: uuid(), blocks: [{ type: 'block', blockId: uuid() }] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.fields.map((f: { path: string }) => f.path)).toEqual(['openingId', 'blocks.0.blockId']);
    expect((await post({ openingId: b.core })).body.error.details.fields[0]).toMatchObject({ path: 'openingId', message: 'Not an opening' });
    expect((await post({ soundId: b.opening })).body.error.details.fields[0]).toMatchObject({ path: 'soundId', message: 'Not a background sound' });
    await q(`UPDATE sound_blocks SET visible=false WHERE id=$1`, [b.sound]);
    expect((await post({ soundId: b.sound })).status).toBe(400); // hidden by the CMS: the option disappears
    await q(`UPDATE sound_blocks SET visible=true WHERE id=$1`, [b.sound]);
    const a = (await post({})).body.data;
    expect((await h().patch(`/v1/recipes/${a.id}`, { lengthMin: 100 }, { token: m.accessToken })).status).toBe(400);
    expect((await h().patch(`/v1/recipes/${a.id}`, { id: uuid() }, { token: m.accessToken })).status).toBe(400);
    expect((await h().patch('/v1/recipes/not-a-uuid', {}, { token: m.accessToken })).status).toBe(400);
  });

  it('nobody can read or change someone else’s recipe', async () => {
    const owner = await member(app, db), other = await member(app, db);
    const r = (await h().post('/v1/recipes', base(), { token: owner.accessToken })).body.data;
    expect((await h().patch(`/v1/recipes/${r.id}`, { name: 'mine now' }, { token: other.accessToken })).status).toBe(404);
    expect((await h().del(`/v1/recipes/${r.id}`, { token: other.accessToken })).status).toBe(404);
    expect((await h().post(`/v1/recipes/${r.id}/share`, {}, { token: other.accessToken })).status).toBe(404);
    expect((await h().get('/v1/recipes', { token: other.accessToken })).body.data).toEqual([]);
    expect((await h().get('/v1/recipes', { token: owner.accessToken })).body.data[0].name).toBe('Sunday OM');
  });

  it('share link: short unique slug, stable, openable by anyone, never shows the author', async () => {
    const m = await member(app, db), free = await guest(app), b = await blocks();
    const r1 = (await h().post('/v1/recipes', base({ name: 'Sunday ÖM — the long one', soundId: b.sound }), { token: m.accessToken })).body.data;
    const r2 = (await h().post('/v1/recipes', base({ name: 'Sunday ÖM — the long one' }), { token: m.accessToken })).body.data;
    const s1 = await h().post(`/v1/recipes/${r1.id}/share`, {}, { token: m.accessToken });
    expect(s1.status).toBe(200);
    expect(s1.body.data.slug).toMatch(/^sunday-om-[a-z0-9-]*[a-z2-9]{4}$/); // diacritics folded, cut at 11 characters + 4 random
    expect(s1.body.data.slug.length).toBeLessThanOrEqual(16);
    expect(s1.body.data.url).toBe(`https://wehum.app/r/${s1.body.data.slug}`);
    expect((await h().post(`/v1/recipes/${r1.id}/share`, {}, { token: m.accessToken })).body.data.slug).toBe(s1.body.data.slug); // idempotent
    const s2 = await h().post(`/v1/recipes/${r2.id}/share`, {}, { token: m.accessToken });
    expect(s2.body.data.slug).not.toBe(s1.body.data.slug);
    expect((await h().get('/v1/recipes', { token: m.accessToken })).body.data.find((x: { id: string }) => x.id === r1.id).shareUrl).toBe(s1.body.data.url);

    const open = await h().get(`/v1/recipes/shared/${s1.body.data.slug}`, { token: free.accessToken }); // anyone with the app
    expect(open.status).toBe(200);
    expect(open.body.data).toMatchObject({ slug: s1.body.data.slug, name: 'Sunday ÖM — the long one', lengthMin: 15, soundId: b.sound });
    expect(Object.keys(open.body.data).sort()).toEqual(['blocks', 'bells', 'lengthMin', 'name', 'openingId', 'slug', 'soundId', 'soundLevel', 'texture'].sort());
    expect(JSON.stringify(open.body)).not.toContain(m.me.id);
    expect((await h().get('/v1/recipes/shared/nope-0000', { token: free.accessToken })).status).toBe(404);
    expect((await h().get('/v1/recipes/shared/X', { token: free.accessToken })).status).toBe(400);
    expect((await h().get(`/v1/recipes/shared/${s1.body.data.slug}`)).status).toBe(401);
    await h().del(`/v1/recipes/${r1.id}`, { token: m.accessToken });
    expect((await h().get(`/v1/recipes/shared/${s1.body.data.slug}`, { token: free.accessToken })).status).toBe(404); // deleting kills the link
  });

  it('at most 100 saved meditations', async () => {
    const m = await member(app, db);
    for (let i = 0; i < 100; i++) await q(`INSERT INTO recipes (id, user_id, name, length_min) VALUES ($1,$2,$3,10)`, [uuid(), m.me.id, `R${i}`]);
    const r = await h().post('/v1/recipes', base(), { token: m.accessToken });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_STATE');
    expect((await h().get('/v1/recipes', { token: m.accessToken })).body.data).toHaveLength(100);
  });
});

describe('P4 performance (in-process, excluding network)', () => {
  it('bootstrap and today meet the cached-read budget (p95 < 50 ms)', async () => {
    const g = await member(app, db);
    const pctl = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
    const t = async (url: string, headers: Record<string, string> = {}) => {
      const xs: number[] = [];
      for (let i = 0; i < 150; i++) {
        if (i % 30 === 29) await clearRates();
        const s = process.hrtime.bigint();
        const r = await h().get(url, { token: g.accessToken, headers });
        xs.push(Number(process.hrtime.bigint() - s) / 1e6);
        expect([200, 304]).toContain(r.status);
      }
      return { p50: pctl(xs, 0.5), p95: pctl(xs, 0.95), p99: pctl(xs, 0.99) };
    };
    await clearRates();
    const etag = (await h().get('/v1/bootstrap', { token: g.accessToken })).headers.etag as string;
    const out = { bootstrap: await t('/v1/bootstrap'), 'bootstrap 304': await t('/v1/bootstrap', { 'if-none-match': etag }), today: await t('/v1/today'), live: await t('/v1/live'), 'group/next': await t('/v1/group/next') };
    console.log('P4 latency (ms)', JSON.stringify(out));
    for (const [name, r] of Object.entries(out)) { expect(r.p95, `${name} p95`).toBeLessThan(50); expect(r.p50, `${name} p50`).toBeLessThan(15); }
  });
});
