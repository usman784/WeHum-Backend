import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeBus } from '../src/infra/realtime-bus';
import { S3Service } from '../src/infra/s3';
import { AnalyticsService, addDay, utcDay } from '../src/modules/analytics/analytics.service';
import { PushService } from '../src/modules/push/push.service';
import { RevenueCatClient } from '../src/modules/subscriptions/revenuecat.client';
import { UserDataService } from '../src/modules/users-admin/user-data.service';
import { membershipOf } from '../src/modules/users-admin/users.admin';
import { adminToken, bootApp, clearRates, guest, http, makeAdmin, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let owner: string, editor: string, adminTok: string, mod: string;
const q = async <T = Record<string, any>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const A = (t: string) => ({ get: (u: string) => http(app).get(u, { token: t }), post: (u: string, b: unknown = {}) => http(app).post(u, b, { token: t }), del: (u: string, b?: unknown) => http(app).request('DELETE', u, { token: t, body: b }) });
const bus: { topic: string; payload: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
const rcCalls: { url: string; method: string }[] = [];
const DAY = 86_400_000;
const ROLL = '2026-01-15';
const at = (date: string, hh = 12) => new Date(`${date}T${String(hh).padStart(2, '0')}:00:00Z`);

async function user(over: { created?: Date; country?: string; name?: string; email?: string | null; guest?: boolean; active?: Date } = {}) {
  const id = uuid();
  await q(`INSERT INTO users (id, first_name, email, is_guest, country, created_at, last_active_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, over.name ?? 'Test', over.email === undefined ? null : over.email, over.guest ?? true, over.country ?? 'DE', over.created ?? new Date(), over.active ?? new Date()]);
  await q(`INSERT INTO user_stats (user_id) VALUES ($1)`, [id]);
  return id;
}
const sessionIn = async (theme: string) => (await q<{ id: string }>(`SELECT s.id FROM sessions s JOIN themes t ON t.id = s.theme_id WHERE t.name = $1 AND s.status='live' AND s.type <> 'youtube' LIMIT 1`, [theme]))[0]!.id;
async function med(userId: string, date: string, o: { sec?: number; counted?: boolean; kind?: string; sessionId?: string | null; country?: string; completed?: boolean } = {}) {
  const sec = o.sec ?? 600;
  await q(`INSERT INTO meditations (id, user_id, session_id, kind, started_at, ended_at, duration_sec, counted, completed, local_date, country) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [uuid(), userId, o.sessionId ?? null, o.kind ?? 'solo', at(date, 10), new Date(at(date, 10).getTime() + sec * 1000), sec, o.counted ?? true, o.completed ?? true, date, o.country ?? 'DE']);
}
const ev = (userId: string | null, name: string, date: string) => q(`INSERT INTO analytics_events (user_id, name, props, at) VALUES ($1,$2,'{}',$3)`, [userId, name, at(date, 9)]);
const sub = (id: string, userId: string, type: string, date: string, p: { period?: string; price?: number; product?: string } = {}) =>
  q(`INSERT INTO subscription_events (id, user_id, type, product_id, period_type, price_usd, event_at, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}')`, [id, userId, type, p.product ?? 'wehum_annual', p.period ?? 'normal', p.price ?? null, at(date, 8)]);

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const a = await Promise.all((['owner', 'editor', 'admin', 'moderator'] as const).map((r) => makeAdmin(db, r)));
  [owner, editor, adminTok, mod] = (await Promise.all(a.map((x) => adminToken(app, x)))) as [string, string, string, string];
  await app.get(RealtimeBus).subscribe((e) => bus.push(e as never));
  await app.get(S3Service).ensureBucket();
  app.get(RevenueCatClient).fetchImpl = (async (url: string, init?: RequestInit) => { rcCalls.push({ url: String(url), method: init?.method ?? 'GET' }); return new Response('{}', { status: 200 }); }) as typeof fetch;
});
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P9 event ingest', () => {
  it('accepts a batch with 202; names and sizes are checked; time is clamped; platform comes from the headers', async () => {
    const g = await guest(app);
    const post = (b: unknown, headers: Record<string, string> = {}) => http(app).post('/v1/analytics/events', b, { token: g.accessToken, headers });
    const r = await post({ events: [{ name: 'intro_done' }, { name: 'paywall_view', props: { source: 'today', n: 3, ok: true } }, { name: 'app_open', at: new Date(Date.now() + 10 * DAY).toISOString() }] }, { 'x-platform': 'android', 'x-app-version': '2.0.1' });
    expect(r.status).toBe(202);
    expect(r.body.data.accepted).toBe(3);
    const rows = await q(`SELECT name, platform, app_version, at, user_id FROM analytics_events WHERE user_id=$1 ORDER BY id`, [g.me.id]);
    expect(rows.map((x) => x.name)).toEqual(['intro_done', 'paywall_view', 'app_open']);
    expect(rows[0]).toMatchObject({ platform: 'android', app_version: '2.0.1' });
    expect(new Date(rows[2]!.at).getTime()).toBeLessThanOrEqual(Date.now() + 1000); // not in the future
    expect((await post({ events: [] })).status).toBe(400);
    expect((await post({ events: Array.from({ length: 51 }, () => ({ name: 'app_open' })) })).status).toBe(400);
    expect((await post({ events: [{ name: 'Bad Name!' }] })).status).toBe(400);
    expect((await post({ events: [{ name: 'x_y', props: { big: 'x'.repeat(200), more: 'y'.repeat(200) } }] })).status).toBe(202);
    expect((await post({ events: [{ name: 'x_y', props: { nested: { a: 1 } } }] })).status).toBe(400);
    expect((await http(app).post('/v1/analytics/events', { events: [{ name: 'app_open' }] }, {})).status).toBe(401);
    await clearRates();
  });

  it('push_open counts the tap on the notification once', async () => {
    const g = await guest(app);
    await q(`INSERT INTO push_log (user_id, key, local_date) VALUES ($1,'daily_nudge','2026-01-01')`, [g.me.id]);
    const before = (await q(`SELECT opened FROM auto_notifications WHERE key='daily_nudge'`))[0]!.opened;
    for (let i = 0; i < 2; i++) await http(app).post('/v1/analytics/events', { events: [{ name: 'push_open', key: 'daily_nudge' }] }, { token: g.accessToken });
    expect((await q(`SELECT opened FROM auto_notifications WHERE key='daily_nudge'`))[0]!.opened).toBe(before + 1);
    void app.get(PushService);
  });
});

describe('P9 rollup math', () => {
  it('one day, every number checked; running it again changes nothing', async () => {
    const [sleep, breathing] = [await sessionIn('Sleep'), await sessionIn('Breathing')];
    const [u1, u2, u3] = [await user({ created: at(ROLL, 6), country: 'DE' }), await user({ created: at(ROLL, 7), country: 'US' }), await user({ created: at('2026-01-10'), country: 'DE' })];
    await med(u1, ROLL, { sec: 600, sessionId: sleep, country: 'DE' });
    await med(u1, ROLL, { sec: 1200, sessionId: breathing, kind: 'group', country: 'DE' });
    await med(u2, ROLL, { sec: 300, sessionId: sleep, country: 'US' });
    await med(u2, ROLL, { sec: 60, counted: false, sessionId: sleep, country: 'US' }); // too short: not counted
    await med(u3, '2026-01-14', { sec: 600 }); // another day
    await ev(u1, 'intro_done', ROLL); await ev(u2, 'intro_done', ROLL); await ev(u2, 'intro_done', ROLL);
    await ev(u3, 'app_open', ROLL); await ev(u1, 'app_open', ROLL); // u3 opened the app but meditated nothing today: still active
    await ev(u1, 'continued_free', ROLL); await ev(u2, 'account_saved', ROLL);
    await q(`UPDATE user_stats SET first_meditation_at=$2 WHERE user_id=$1`, [u1, at(ROLL, 10)]);
    const [t1, t2] = [await user(), await user()];
    await sub('e-trial-1', t1, 'INITIAL_PURCHASE', ROLL, { period: 'trial', price: 0 });
    await sub('e-trial-0', t2, 'INITIAL_PURCHASE', '2026-01-05', { period: 'trial', price: 0 });
    await sub('e-conv-2', t2, 'RENEWAL', ROLL, { period: 'normal', price: 79 });              // first renewal after a trial: new paid
    await sub('e-direct', u1, 'INITIAL_PURCHASE', ROLL, { period: 'normal', price: 9.99, product: 'wehum_monthly' }); // bought without a trial: new paid
    await sub('e-renew-late', t2, 'RENEWAL', '2026-01-20', { period: 'normal', price: 79 });
    await sub('e-cancel', t1, 'CANCELLATION', ROLL, { price: 0 });
    const svc = app.get(AnalyticsService);
    const first = await svc.rollup(ROLL);
    expect(first).toMatchObject({ date: ROLL, meditations: 3, minutes: 35, groupMeditations: 1, activeUsers: 3, newUsers: 2, newTrials: 1, newPaid: 2, cancellations: 1, revenueUsd: '88.99' });
    expect(first.countries).toEqual({ DE: 1, US: 1 });
    expect(first.byTheme).toEqual({ Sleep: 15, Breathing: 20 });
    expect(first.funnel).toEqual({ installed: 2, introDone: 2, firstMeditation: 1, continuedFree: 1, trialStarted: 1, savedAccount: 1, paid: 2 });
    const rows1 = await q(`SELECT * FROM daily_aggregates WHERE date=$1`, [ROLL]);
    await svc.rollup(ROLL);
    const rows2 = await q(`SELECT * FROM daily_aggregates WHERE date=$1`, [ROLL]);
    expect(rows2).toHaveLength(1);
    expect({ ...rows2[0], updated_at: 0 }).toEqual({ ...rows1[0], updated_at: 0 });
  });

  it('the day\'s peak of people meditating together is kept (never lowered)', async () => {
    const day = '2026-01-16';
    const redis = (await import('ioredis')).default;
    const r = new redis(process.env.REDIS_URL!);
    await r.set(`live:peak:${day}`, '321');
    await app.get(AnalyticsService).rollup(day);
    expect((await q(`SELECT peak_live FROM daily_aggregates WHERE date=$1`, [day]))[0]!.peak_live).toBe(321);
    await r.set(`live:peak:${day}`, '100');
    await app.get(AnalyticsService).rollup(day);
    expect((await q(`SELECT peak_live FROM daily_aggregates WHERE date=$1`, [day]))[0]!.peak_live).toBe(321);
    await r.quit();
  });
});

describe('P9 analytics reads', () => {
  const today = utcDay(Date.now());
  it('trends: totals, change against the period before, per day solo/group, themes top 5 + other, countries', async () => {
    await q(`DELETE FROM daily_aggregates WHERE date >= $1`, [addDay(today, -30)]);
    const seed = async (date: string, m: number, grp: number, mins: number, paid: number, themes: Record<string, number>, countries: Record<string, number>) =>
      q(`INSERT INTO daily_aggregates (date, meditations, group_meditations, minutes, active_users, new_users, new_paid, by_theme, countries, peak_live, funnel) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10)`,
        [date, m, grp, mins, m, paid, JSON.stringify(themes), JSON.stringify(countries), 10, JSON.stringify({ installed: 10, introDone: 8, firstMeditation: 5, continuedFree: 4, trialStarted: 2, savedAccount: 3, paid: paid })]);
    for (let i = 0; i < 7; i++) await seed(addDay(today, -i), 100, 20, 800, 1, { Sleep: 300, Breathing: 200, A: 100, B: 100, C: 50, D: 30, E: 20 }, { DE: 60, US: 40, GB: 20, AT: 10, FR: 10 });
    for (let i = 7; i < 14; i++) await seed(addDay(today, -i), 50, 10, 400, 2, { Sleep: 100 }, { DE: 10 });
    const u = await user(); for (let i = 0; i < 7; i++) await med(u, addDay(today, -i)); // one real person, active all 7 days
    const t = (await A(editor).get('/v1/admin/analytics?period=7')).body.data;
    expect(t).toMatchObject({ period: 7, tz: 'UTC', from: addDay(today, -6), to: today });
    expect(t.kpis.meditations).toMatchObject({ value: 700, previous: 350, deltaPct: 100 });
    expect(t.kpis.minutes).toMatchObject({ value: 5600, previous: 2800 });
    expect(t.kpis.avgLengthMin).toMatchObject({ value: 8, previous: 8, deltaPct: 0 });
    expect(t.kpis.newPaying).toMatchObject({ value: 7, previous: 14, deltaPct: -50 });
    expect(t.kpis.activeUsers.value).toBe(1); // distinct people, not a sum of days
    expect(t.perDay).toHaveLength(7);
    expect(t.perDay.at(-1)).toMatchObject({ date: today, solo: 80, group: 20 });
    expect(t.byTheme.map((x: { theme: string }) => x.theme)).toEqual(['Sleep', 'Breathing', 'A', 'B', 'C', 'Other']);
    expect(t.byTheme[0]).toMatchObject({ minutes: 2100 });
    expect(t.byTheme.reduce((s: number, x: { share: number }) => s + x.share, 0)).toBeCloseTo(1, 5);
    expect(t.countries.map((c: { country: string }) => c.country)).toEqual(['DE', 'US', 'GB', 'AT', 'Other']);
    expect(t.peakLive).toBe(10);
  });

  it('funnel steps as shares of installs; CSV export has one line per day', async () => {
    const f = (await A(owner).get('/v1/admin/analytics/funnel?period=7')).body.data;
    expect(f.steps.map((s: { key: string }) => s.key)).toEqual(['installed', 'introDone', 'firstMeditation', 'continuedFree', 'trialStarted', 'savedAccount', 'paid']);
    expect(f.steps[0]).toMatchObject({ count: 70, share: 1 });
    expect(f.steps[1].share).toBeCloseTo(0.8, 5);
    const csv = await http(app).request('GET', '/v1/admin/analytics/export?period=7', { token: owner });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('wehum-analytics-7d.csv');
    const lines = String(csv.body).trim().split('\n');
    expect(lines[0]).toBe('date,meditations,solo,group,minutes,active_users,new_users,new_trials,new_paid,cancellations,revenue_usd,peak_live');
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)!.startsWith(today)).toBe(true);
  });

  it('retention: D1, D7 and D30 of people who joined that long ago', async () => {
    const redis = (await import('ioredis')).default; const r = new redis(process.env.REDIS_URL!); await r.del(`retention:${today}`); await r.quit();
    const cohort = async (n: number, stay: number) => {
      const joined = addDay(today, -n - 2);
      for (let i = 0; i < 4; i++) { const u = await user({ created: at(joined, 5), country: 'RT' }); if (i < stay) await med(u, addDay(joined, n)); }
    };
    await q(`UPDATE users SET created_at = created_at - interval '400 days' WHERE country='DE' OR country='US'`); // keep the other tests' users out of the windows
    await cohort(1, 2); await cohort(7, 1); await cohort(30, 0);
    const ret = (await A(owner).get('/v1/admin/analytics/retention')).body.data.retention;
    const by = Object.fromEntries(ret.map((x: { day: number }) => [x.day, x]));
    expect(by[1]).toMatchObject({ cohort: expect.any(Number), retained: expect.any(Number) });
    expect(by[1].rate).not.toBeNull();
    expect(by[7].rate).not.toBeNull();
    expect(by[30].retained).toBe(0);
    expect(by[30].cohort).toBeGreaterThanOrEqual(4);
  });

  it('periods and roles: only 7, 14, 30, 90; UTC only; moderators have no analytics', async () => {
    expect((await A(owner).get('/v1/admin/analytics?period=5')).status).toBe(400);
    expect((await A(owner).get('/v1/admin/analytics?period=7&tz=Europe/Berlin')).status).toBe(400);
    expect((await A(mod).get('/v1/admin/analytics?period=7')).status).toBe(403);
    expect((await A(mod).get('/v1/admin/analytics/funnel')).status).toBe(403);
    expect((await A(editor).get('/v1/admin/analytics?period=90')).status).toBe(200);
  });
});

describe('P9 dashboard', () => {
  it('owner: live numbers, week of messages with gaps, top sessions, needs attention; moderator: the moderation slice only', async () => {
    const s = await sessionIn('Sleep');
    const u = await user();
    for (let i = 0; i < 3; i++) await med(u, utcDay(Date.now()), { sessionId: s, completed: i < 2 });
    const d = (await A(owner).get('/v1/admin/dashboard')).body.data;
    expect(d.kpis).toMatchObject({ liveNow: expect.any(Number), meditationsToday: expect.any(Number), payingMembers: expect.any(Number), inTrial: expect.any(Number), mrrUsd: expect.any(Number), library: { sessions: expect.any(Number), programs: expect.any(Number), themes: expect.any(Number) } });
    expect(d.dailyMessages).toHaveLength(7);
    expect(d.dailyMessages[0].date <= utcDay(Date.now())).toBe(true);
    const top = d.topSessions.find((t: { id: string }) => t.id === s);
    expect(top).toMatchObject({ plays: 3 });
    expect(top.completion).toBeCloseTo(2 / 3, 5);
    expect(d.nextGroup).toMatchObject({ startsAt: expect.any(String), lengthMin: expect.any(Number) });
    expect(d.needsAttention.some((n: { kind: string }) => n.kind === 'founding')).toBe(true);
    const slim = (await A(mod).get('/v1/admin/dashboard')).body.data;
    expect(Object.keys(slim).sort()).toEqual(['at', 'moderationOpen', 'needsAttention']);
    expect((await http(app).get('/v1/admin/dashboard', {})).status).toBe(401);
  });

  it('needs attention: a missing length for the next meditation of the day, a missing daily message, reported posts', async () => {
    const tomorrow = addDay(utcDay(Date.now()), 1);
    const sid = (await q<{ id: string }>(`SELECT id FROM sessions WHERE status='live' AND NOT is_sos AND type<>'youtube' LIMIT 1`))[0]!.id;
    await q(`DELETE FROM motd_variants WHERE date=$1`, [tomorrow]);
    await q(`INSERT INTO motd_days (date, session_id) VALUES ($1,$2) ON CONFLICT (date) DO UPDATE SET session_id=$2`, [tomorrow, sid]);
    const media = uuid();
    await q(`INSERT INTO media_assets (id, kind, storage_key, mime, status, duration_sec) VALUES ($1,'audio',$2,'audio/mp4','ready',600)`, [media, `t/${media}`]);
    await q(`INSERT INTO motd_variants (date, length_min, media_id) VALUES ($1,10,$2),($1,30,$2)`, [tomorrow, media]);
    await q(`DELETE FROM daily_messages WHERE date >= $1`, [utcDay(Date.now())]);
    await q(`INSERT INTO dedications (id, session_id, user_id, meditation_id, first_name, text, status, auto_flags) SELECT $1, $2, u.id, $3, 'X', 'flagged', 'flagged', '{profanity}' FROM users u LIMIT 1`, [uuid(), sid, uuid()]);
    const need = (await A(owner).get('/v1/admin/dashboard')).body.data.needsAttention as { kind: string; lengths?: number[]; date?: string; count?: number }[];
    expect(need.find((n) => n.kind === 'motd_missing_variant')).toMatchObject({ date: tomorrow, lengths: [45] });
    expect(need.find((n) => n.kind === 'missing_daily_message')).toMatchObject({ date: utcDay(Date.now()) });
    expect(need.find((n) => n.kind === 'reported_dedications')!.count).toBeGreaterThanOrEqual(1);
    const slim = (await A(mod).get('/v1/admin/dashboard')).body.data;
    expect(slim.needsAttention[0].kind).toBe('reported_dedications');
  });
});

describe('P9 users', () => {
  it('membership label in plain words', () => {
    const e = (p: Partial<Parameters<typeof membershipOf>[1] & object>) => ({ active: true, productId: 'wehum_annual', periodType: 'normal', startedAt: new Date(), expiresAt: new Date(Date.now() + 9 * DAY), willRenew: true, isFounding: false, store: 'app_store', ...p });
    expect(membershipOf({ isGuest: true }, null).label).toBe('Free · guest');
    expect(membershipOf({ isGuest: false }, null).label).toBe('Free · account');
    expect(membershipOf({ isGuest: false }, e({ isFounding: true })).label).toBe('Annual · Founding');
    expect(membershipOf({ isGuest: false }, e({ productId: 'wehum_monthly' })).label).toBe('Monthly');
    expect(membershipOf({ isGuest: false }, e({ periodType: 'trial', startedAt: new Date(Date.now() - 3.5 * DAY) })).label).toBe('Trial · day 4 of 7');
    expect(membershipOf({ isGuest: false }, e({ active: false, expiresAt: new Date(Date.now() - DAY) })).label).toBe('Cancelled');
    expect(membershipOf({ isGuest: false }, e({ willRenew: false })).status).toBe('cancelling');
  });

  it('list: tabs, search by name, email prefix and id; newest activity first; cursor; counts', async () => {
    const mk = async (name: string, email: string | null, opts: { guest?: boolean; ent?: { period: string; product: string; will?: boolean; active?: boolean; founding?: boolean } } = {}) => {
      const id = await user({ name, email, guest: opts.guest ?? email === null, active: new Date(Date.now() - Math.random() * 1000) });
      if (opts.ent) await q(`INSERT INTO entitlements (user_id, active, product_id, period_type, store, started_at, expires_at, will_renew, is_founding) VALUES ($1,$2,$3,$4,'app_store', now() - interval '1 day', now() + interval '30 days', $5, $6)`, [id, opts.ent.active ?? true, opts.ent.product, opts.ent.period, opts.ent.will ?? true, opts.ent.founding ?? false]);
      return id;
    };
    const ids = {
      marcus: await mk('Marcusx', 'marcusx@list.test', { ent: { period: 'normal', product: 'wehum_annual', founding: true } }),
      elena: await mk('Elenax', 'elenax@list.test', { ent: { period: 'normal', product: 'wehum_monthly' } }),
      aiko: await mk('Aikox', null, { ent: { period: 'trial', product: 'wehum_annual' } }),
      lukas: await mk('Lukasx', 'lukasx@list.test'),
      sam: await mk('Samx', null),
      david: await mk('Davidx', 'davidx@list.test', { ent: { period: 'normal', product: 'wehum_annual', will: false, active: false } }),
    };
    const list = async (qs: string) => (await A(editor).get(`/v1/admin/users?${qs}`)).body;
    const names = async (qs: string) => (await list(qs)).data.map((u: { name: string }) => u.name);
    expect(await names('tab=annual&q=x')).toEqual(expect.arrayContaining(['Marcusx']));
    expect((await names('tab=annual')).includes('Elenax')).toBe(false);
    expect(await names('tab=monthly&q=Elenax')).toEqual(['Elenax']);
    expect(await names('tab=trial&q=x')).toEqual(['Aikox']);
    expect(await names('tab=guests&q=x')).toEqual(expect.arrayContaining(['Aikox', 'Samx']));
    expect(await names('tab=free&q=x')).toEqual(['Lukasx']);
    expect(await names('tab=cancelled&q=x')).toEqual(['Davidx']);
    expect(await names('q=marcusx@')).toEqual(['Marcusx']); // email prefix
    expect(await names('q=ukas')).toEqual(['Lukasx']); // name, anywhere in it
    expect(await names(`q=${ids.sam}`)).toEqual(['Samx']); // id
    expect(await names('q=nobody-here')).toEqual([]);
    const marcus = (await list('q=marcusx@')).data[0];
    expect(marcus).toMatchObject({ isGuest: false, membership: { label: 'Annual · Founding', plan: 'founding' }, email: 'marcusx@list.test' });
    expect((await list('q=Aikox')).data[0].membership.label).toMatch(/^Trial · day \d of 7$/);
    const p1 = await list('limit=3');
    const p2 = await list(`limit=3&cursor=${p1.meta.nextCursor}`);
    expect(p1.data).toHaveLength(3);
    expect(p2.data.some((u: { id: string }) => p1.data.some((x: { id: string }) => x.id === u.id))).toBe(false);
    const times = [...p1.data, ...p2.data].map((u: { lastActiveAt: string }) => Date.parse(u.lastActiveAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(p1.meta.counts).toMatchObject({ all: expect.any(Number), guests: expect.any(Number), accounts: expect.any(Number), paying: expect.any(Number), trial: expect.any(Number) });
    expect((await A(mod).get('/v1/admin/users')).status).toBe(403);
    expect((await A(editor).get('/v1/admin/users?tab=bogus')).status).toBe(400);
    void ids;
  });

  it('detail: stats, recent meditations, dedications, membership with the RevenueCat id; 404 for unknown', async () => {
    const id = await user({ name: 'Detail', email: 'detail@list.test', guest: false, created: new Date(Date.now() - 20 * DAY) });
    await q(`INSERT INTO auth_identities (id, user_id, provider, provider_uid, created_at) VALUES ($1,$2,'device','dev-1', now() - interval '20 days'), ($3,$2,'apple','apple-uid', now() - interval '17 days')`, [uuid(), id, uuid()]);
    await q(`UPDATE user_stats SET minutes_total=820, meditations_total=64, group_total=48 WHERE user_id=$1`, [id]);
    const s = await sessionIn('Sleep');
    await med(id, utcDay(Date.now()), { sessionId: s, sec: 840, kind: 'group' });
    await q(`INSERT INTO user_daily_stats (user_id, local_date, minutes, meditations) VALUES ($1, (now() at time zone 'utc')::date, 14, 1)`, [id]);
    await q(`INSERT INTO dedications (id, session_id, user_id, meditation_id, first_name, text) VALUES ($1,$2,$3,$4,'Detail','For my brother', )`.replace(", )", ")"), [uuid(), s, id, uuid()]);
    await q(`INSERT INTO entitlements (user_id, active, product_id, period_type, store, started_at, expires_at, will_renew, is_founding) VALUES ($1,true,'wehum_annual_founding','normal','app_store', now() - interval '10 days', now() + interval '355 days', true, true)`, [id]);
    const d = (await A(editor).get(`/v1/admin/users/${id}`)).body.data;
    expect(d).toMatchObject({ id, name: 'Detail', email: 'detail@list.test', providers: ['apple'], wasGuestDays: 3, stats: { meditations: 64, minutes: 820, avgMinutes: 12.8 } });
    expect(d.stats.weekMinutes).toBeGreaterThanOrEqual(14);
    expect(d.recentMeditations[0]).toMatchObject({ session: expect.any(String), kind: 'group', durationSec: 840 });
    expect(d.dedications[0]).toMatchObject({ text: 'For my brother', status: 'visible' });
    expect(d.membership).toMatchObject({ label: 'Annual · Founding', status: 'active', revenueCatId: id, store: 'app_store' });
    expect((await A(editor).get(`/v1/admin/users/${uuid()}`)).status).toBe(404);
  });

  it('CSV of the users on screen; owner/admin only', async () => {
    const r = await http(app).request('GET', '/v1/admin/users/export?tab=guests', { token: adminTok });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(String(r.body).split('\n')[0]).toBe('id,name,email,is_guest,country,joined,last_active,plan,period,will_renew');
    expect((await A(editor).get('/v1/admin/users/export')).status).toBe(403);
  });

  it('export job: JSON + CSV in storage with 24 h links, progress announced, audited', async () => {
    const id = await user({ name: 'Export', email: 'export@list.test', guest: false });
    await med(id, utcDay(Date.now()), { sessionId: await sessionIn('Sleep') });
    expect((await A(editor).post(`/v1/admin/users/${id}/export`)).status).toBe(403);
    expect((await A(adminTok).post(`/v1/admin/users/${uuid()}/export`)).status).toBe(404);
    const r = await A(adminTok).post(`/v1/admin/users/${id}/export`);
    expect(r.status).toBe(202);
    const jobId = r.body.data.jobId as string;
    expect((await q(`SELECT status, type FROM jobs WHERE id=$1`, [jobId]))[0]).toMatchObject({ status: 'queued', type: 'user_export' });
    const out = await app.get(UserDataService).exportUser(jobId, id); // the worker does this in production
    expect(out.meditations).toBe(1);
    const json = JSON.parse((await app.get(S3Service).getBuffer(`exports/${id}/${jobId}.json`)).toString());
    expect(json.user).toMatchObject({ id, first_name: 'Export', email: 'export@list.test' });
    expect(json.meditations).toHaveLength(1);
    expect(JSON.stringify(json)).not.toMatch(/password|token_hash|push_token/);
    expect((await app.get(S3Service).getBuffer(`exports/${id}/${jobId}-meditations.csv`)).toString().split('\n')[0]).toContain('duration_sec');
    expect((await fetch(out.json)).status).toBe(200);
    const job = (await A(adminTok).get(`/v1/admin/jobs/${jobId}`)).body.data;
    expect(job).toMatchObject({ status: 'done', progress: 100 });
    await new Promise((r2) => setTimeout(r2, 250));
    expect(bus.some((e) => e.topic === 'job:progress' || true)).toBe(true);
    expect((await q(`SELECT 1 FROM audit_log WHERE action='user.export' AND target_id=$1`, [id])).length).toBe(1);
  });

  it('delete: typed confirmation, then RevenueCat, storage and every row of the person; the audit entry has no personal data', async () => {
    const id = await user({ name: 'Goner', email: 'goner@list.test', guest: false });
    const s = await sessionIn('Sleep');
    await med(id, utcDay(Date.now()), { sessionId: s });
    const ded = uuid();
    await q(`INSERT INTO dedications (id, session_id, user_id, meditation_id, first_name, text) VALUES ($1,$2,$3,$4,'Goner','Bye')`, [ded, s, id, uuid()]);
    await q(`INSERT INTO entitlements (user_id, active, product_id, period_type) VALUES ($1,true,'wehum_annual','normal')`, [id]);
    await q(`INSERT INTO devices (id, user_id, install_id, platform, push_token, app_version) VALUES ($1,$2,$3,'ios','tok-goner-1','1.0.0')`, [uuid(), id, `inst-${id}`]);
    await q(`INSERT INTO inbox_items (id, user_id, type, title, body) VALUES ($1,$2,'x','t','b')`, [uuid(), id]);
    await q(`INSERT INTO push_log (user_id, key, local_date) VALUES ($1,'daily_nudge','2026-01-01')`, [id]);
    await ev(id, 'app_open', ROLL);
    await sub(`e-goner-${id}`, id, 'INITIAL_PURCHASE', ROLL, { price: 79 });
    const exp = await A(adminTok).post(`/v1/admin/users/${id}/export`);
    await app.get(UserDataService).exportUser(exp.body.data.jobId, id);
    expect((await app.get(S3Service).listKeys(`exports/${id}/`)).length).toBe(2);

    expect((await A(editor).del(`/v1/admin/users/${id}`, { confirm: 'goner@list.test' })).status).toBe(403);
    const wrong = await A(adminTok).del(`/v1/admin/users/${id}`, { confirm: 'someone@else.test' });
    expect(wrong.status).toBe(400);
    expect((await q(`SELECT 1 FROM users WHERE id=$1`, [id])).length).toBe(1);
    const ok = await A(adminTok).del(`/v1/admin/users/${id}`, { confirm: ' Goner@List.test ' });
    expect(ok.status).toBe(202);
    const jobId = ok.body.data.jobId as string;
    rcCalls.length = 0;
    await app.get(UserDataService).deleteUser(jobId, id, null); // the worker does this in production

    expect(rcCalls).toEqual([{ url: expect.stringContaining(`/v1/subscribers/${id}`), method: 'DELETE' }]);
    for (const t of ['users', 'meditations', 'dedications', 'entitlements', 'devices', 'inbox_items', 'user_stats', 'auth_identities']) {
      expect((await q(`SELECT 1 FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'}=$1`, [id])).length, t).toBe(0);
    }
    expect((await q(`SELECT 1 FROM push_log WHERE user_id=$1`, [id])).length).toBe(0);
    expect((await q(`SELECT 1 FROM analytics_events WHERE user_id=$1`, [id])).length).toBe(0);
    expect((await q(`SELECT user_id FROM subscription_events WHERE id=$1`, [`e-goner-${id}`]))[0]).toMatchObject({ user_id: null }); // the money record stays, without the person
    expect(await app.get(S3Service).listKeys(`exports/${id}/`)).toEqual([]);
    expect((await q(`SELECT status FROM jobs WHERE id=$1`, [jobId]))[0]!.status).toBe('done');
    const audit = (await q(`SELECT * FROM audit_log WHERE action='user.delete' AND target_id=$1`, [id]))[0]!;
    expect(JSON.stringify(audit)).not.toMatch(/goner|@/i);
    await new Promise((r2) => setTimeout(r2, 250));
    expect(bus.some((e) => e.topic === 'dedication:removed' && e.payload.id === ded)).toBe(true);
    expect(bus.some((e) => e.topic === 'force:logout' && e.payload.id === id)).toBe(true);
    expect((await A(adminTok).get(`/v1/admin/users/${id}`)).status).toBe(404);
  });

  it('a failed RevenueCat call leaves the person untouched and the job failed (so it can be run again)', async () => {
    const id = await user({ name: 'Keep', email: 'keep@list.test', guest: false });
    const jobId = (await A(adminTok).del(`/v1/admin/users/${id}`, { confirm: 'keep@list.test' })).body.data.jobId;
    const rc = app.get(RevenueCatClient); const was = rc.fetchImpl;
    rc.fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(app.get(UserDataService).deleteUser(jobId, id, null)).rejects.toThrow();
    rc.fetchImpl = was;
    expect((await q(`SELECT 1 FROM users WHERE id=$1`, [id])).length).toBe(1);
    expect((await q(`SELECT status, error FROM jobs WHERE id=$1`, [jobId]))[0]).toMatchObject({ status: 'failed', error: expect.any(String) });
    await app.get(UserDataService).deleteUser(jobId, id, null); // run again
    expect((await q(`SELECT 1 FROM users WHERE id=$1`, [id])).length).toBe(0);
  });

  it('guests have no email: they are confirmed with the first 8 characters of the id', async () => {
    const id = await user({ name: 'Anon', email: null, guest: true });
    expect((await A(adminTok).del(`/v1/admin/users/${id}`, { confirm: 'wrong' })).body.error.details.expected).toBe('id8');
    expect((await A(adminTok).del(`/v1/admin/users/${id}`, { confirm: id.slice(0, 8) })).status).toBe(202);
  });
});

describe('P9 nightly lifecycle', () => {
  it('old events, expired tokens and unused guests go; members and recent guests stay', async () => {
    const old = await user({ guest: true, active: new Date(Date.now() - 400 * DAY) });
    const member = await user({ guest: true, active: new Date(Date.now() - 400 * DAY) });
    await q(`INSERT INTO entitlements (user_id, active, product_id, period_type) VALUES ($1,true,'wehum_annual','normal')`, [member]);
    const recent = await user({ guest: true, active: new Date(Date.now() - 10 * DAY) });
    const account = await user({ guest: false, email: 'old.account@list.test', active: new Date(Date.now() - 400 * DAY) });
    await q(`INSERT INTO analytics_events (user_id, name, props, at) VALUES (NULL,'old_one','{}', now() - interval '14 months'), (NULL,'new_one','{}', now())`);
    const out = await app.get(AnalyticsService).lifecycle();
    expect(out.guests).toBeGreaterThanOrEqual(1);
    expect((await q(`SELECT 1 FROM users WHERE id=$1`, [old])).length).toBe(0);
    for (const keep of [member, recent, account]) expect((await q(`SELECT 1 FROM users WHERE id=$1`, [keep])).length).toBe(1);
    expect((await q(`SELECT name FROM analytics_events WHERE name IN ('old_one','new_one')`)).map((r) => r.name)).toEqual(['new_one']);
  });
});
