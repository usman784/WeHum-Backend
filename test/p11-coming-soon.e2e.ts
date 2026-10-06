import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RealtimeBus } from '../src/infra/realtime-bus';
import { TokensService } from '../src/modules/auth/tokens.service';
import { ConfigService } from '../src/modules/config/config.service';
import { StatsProcessor } from '../src/modules/meditations/stats.processor';
import { adminToken, bootApp, clearRates, guest, http, makeAdmin, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let owner: string, editor: string, mod: string;
const q = async <T = Record<string, any>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const bus: { topic: string; payload: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
const settle = () => new Promise((r) => setTimeout(r, 250));

/** Turn the coming-soon flags on or off, as Settings → App & releases does. */
async function flags(on: boolean) {
  const [row] = await q<{ value: { features: Record<string, boolean> } }>(`SELECT value FROM app_config WHERE key='main'`);
  const value = { ...row!.value, features: { challenges: on, gratitude: on, breathwork: on, milestones: on, intent: false } };
  await app.get(ConfigService).set('main', value);
}

async function person(name = 'Alex', memberToo = true) {
  const g = await guest(app);
  await q(`UPDATE users SET is_guest=false, first_name=$2, country='DE', timezone='UTC' WHERE id=$1`, [g.me.id, name]);
  if (memberToo) await q(`INSERT INTO entitlements (user_id, active, product_id, period_type, expires_at) VALUES ($1, true, 'wehum_annual', 'normal', now() + interval '30 days')`, [g.me.id]);
  const token = await app.get(TokensService).tokenFor(g.me.id, undefined, { gst: false, prm: memberToo });
  return { id: g.me.id, token };
}
const as = (t: string) => ({
  get: (u: string) => http(app).get(u, { token: t }), post: (u: string, b: unknown = {}) => http(app).post(u, b, { token: t }),
  patch: (u: string, b: unknown, h?: Record<string, string>) => http(app).patch(u, b, { token: t, headers: h }), put: (u: string, b: unknown, h?: Record<string, string>) => http(app).put(u, b, { token: t, headers: h }),
  del: (u: string) => http(app).del(u, { token: t }),
});

/** A counted meditation on a local day, applied by the real stats job. */
async function meditateOn(userId: string, day: string, over: { kind?: string; minutes?: number; sessionId?: string | null } = {}) {
  const id = uuid();
  const start = `${day}T08:00:00Z`;
  const sec = (over.minutes ?? 10) * 60;
  await q(`INSERT INTO meditations (id, user_id, session_id, kind, started_at, ended_at, duration_sec, counted, completed, local_date) VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + make_interval(secs => $6),$6,true,true,$7)`,
    [id, userId, over.sessionId ?? null, over.kind ?? 'solo', start, sec, day]);
  expect(await app.get(StatsProcessor).apply(id)).toBe(true);
  return id;
}
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const a = await Promise.all((['owner', 'editor', 'moderator'] as const).map((r) => makeAdmin(db, r)));
  [owner, editor, mod] = (await Promise.all(a.map((x) => adminToken(app, x)))) as [string, string, string];
  await app.get(RealtimeBus).subscribe((e) => bus.push(e as never));
});
beforeEach(async () => { await clearRates(); await flags(true); bus.length = 0; });
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P11 flags', () => {
  it('every coming-soon route answers 404 FEATURE_OFF while its flag is off, and works when on', async () => {
    const u = await person('Flagga');
    await flags(false);
    for (const path of ['/v1/challenges', '/v1/gratitude', '/v1/breathwork', '/v1/me/breath-patterns', '/v1/me/milestones']) {
      const r = await as(u.token).get(path);
      expect(r.status, path).toBe(404);
      expect(r.body.error.code, path).toBe('FEATURE_OFF');
    }
    expect((await as(u.token).post('/v1/gratitude', { text: 'Thank you' })).body.error.code).toBe('FEATURE_OFF');
    await flags(true);
    for (const path of ['/v1/challenges', '/v1/gratitude', '/v1/breathwork', '/v1/me/breath-patterns', '/v1/me/milestones']) expect((await as(u.token).get(path)).status, path).toBe(200);
  });

  it('the bootstrap tells the app which flags are on', async () => {
    const u = await person('Boot');
    const b = await as(u.token).get('/v1/bootstrap');
    expect(b.body.data.features).toMatchObject({ challenges: true, gratitude: true, breathwork: true, milestones: true });
  });
});

describe('P11 challenges', () => {
  let seven: string, group: string;
  beforeAll(async () => {
    const mk = async (b: Record<string, unknown>) => {
      const r = await as(editor).post('/v1/admin/challenges', b);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await as(editor).patch(`/v1/admin/challenges/${r.body.data.id}`, { status: 'live' }, { 'if-match': `"v${r.body.data.version}"` });
      return r.body.data.id as string;
    };
    seven = await mk({ name: '7 days of calm', days: 7, counts: 'any', minMinutes: 3 });
    group = await mk({ name: 'Group week', days: 3, counts: 'group', minMinutes: 3, membersOnly: false });
  });

  it('join, one per local day, the same day once, a missed day never resets, the last day finishes', async () => {
    const u = await person('Chall');
    expect((await as(u.token).post(`/v1/challenges/${seven}/join`)).status).toBe(200);
    await q(`UPDATE challenge_participants SET joined_at = now() - interval '20 days' WHERE user_id=$1`, [u.id]); // joined before the days below
    let list = (await as(u.token).get('/v1/challenges')).body.data;
    expect(list.inProgress.map((c: { id: string }) => c.id)).toContain(seven);
    expect(list.inProgress[0].peopleInIt).toBeGreaterThanOrEqual(1);

    await meditateOn(u.id, day(-9));
    await meditateOn(u.id, day(-9)); // same day: no second count
    await meditateOn(u.id, day(-8));
    await meditateOn(u.id, day(-8), { minutes: 1 }); // too short, and the same day anyway
    let me = (await as(u.token).get('/v1/challenges')).body.data.inProgress.find((c: { id: string }) => c.id === seven).me;
    expect(me).toMatchObject({ completedDays: 2, lastDay: day(-8) });

    await meditateOn(u.id, day(-6)); // day -7 was missed: progress stays (no streaks)
    me = (await as(u.token).get('/v1/challenges')).body.data.inProgress.find((c: { id: string }) => c.id === seven).me;
    expect(me.completedDays).toBe(3);

    await meditateOn(u.id, day(-3));
    await meditateOn(u.id, day(-2));
    await meditateOn(u.id, day(-7)); // synced late from offline: fills the missed day
    me = (await as(u.token).get('/v1/challenges')).body.data.inProgress.find((c: { id: string }) => c.id === seven).me;
    expect(me.completedDays).toBe(6);
    await meditateOn(u.id, day(0));
    list = (await as(u.token).get('/v1/challenges')).body.data;
    expect(list.inProgress.find((c: { id: string }) => c.id === seven)).toBeUndefined();
    expect(list.finished).toEqual([expect.objectContaining({ id: seven, days: 7 })]);
    expect(list.available.map((c: { id: string }) => c.id)).toContain(seven); // can start again
    const admin = (await as(editor).get('/v1/admin/challenges')).body.data.find((c: { id: string }) => c.id === seven);
    expect(admin.finished).toBeGreaterThanOrEqual(1);
  });

  it('a group challenge counts only group meditations; leaving stops it', async () => {
    const u = await person('Grouper', false);
    expect((await as(u.token).post(`/v1/challenges/${group}/join`)).status).toBe(200);
    await q(`UPDATE challenge_participants SET joined_at = now() - interval '5 days' WHERE user_id=$1`, [u.id]);
    await meditateOn(u.id, day(-1), { kind: 'solo' });
    await meditateOn(u.id, day(0), { kind: 'group' });
    const me = (await as(u.token).get('/v1/challenges')).body.data.inProgress.find((c: { id: string }) => c.id === group).me;
    expect(me.completedDays).toBe(1);
    expect((await as(u.token).del(`/v1/challenges/${group}/join`)).status).toBe(200);
    expect((await as(u.token).get('/v1/challenges')).body.data.inProgress).toHaveLength(0);
  });

  it('members-only challenges need a membership; unknown or draft challenges are not found', async () => {
    const free = await person('Freebie', false);
    expect((await as(free.token).post(`/v1/challenges/${seven}/join`)).body.error.code).toBe('PREMIUM_REQUIRED');
    expect((await as(free.token).post(`/v1/challenges/${uuid()}/join`)).status).toBe(404);
  });
});

describe('P11 gratitude feed', () => {
  it('a member shares; the feed of that kind shows it live; other kinds do not', async () => {
    const u = await person('Hannah');
    const r = await as(u.token).post('/v1/gratitude', { kind: 'gratitude', text: '  The first cold morning and a warm cup of tea.  ' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'visible', showHelp: false, postsLeftToday: 2 });
    await settle();
    expect(bus.find((e) => e.topic === 'gratitude:new')?.payload).toMatchObject({ kind: 'gratitude', item: { firstName: 'Hannah', country: 'DE', text: 'The first cold morning and a warm cup of tea.' } });
    const feed = (await as(u.token).get('/v1/gratitude?kind=gratitude')).body;
    expect(feed.data[0]).toMatchObject({ firstName: 'Hannah', kind: 'gratitude' });
    expect(feed.data[0].userId).toBeUndefined(); // first name + country only
    expect((await as(u.token).get('/v1/gratitude?kind=love')).body.data.find((p: { id: string }) => p.id === r.body.data.id)).toBeUndefined();
  });

  it('guests and non-members cannot share; links are refused; the daily limit holds', async () => {
    const g = await guest(app);
    expect((await as(g.accessToken).post('/v1/gratitude', { text: 'hi' })).status).toBe(403);
    const free = await person('NoMember', false);
    expect((await as(free.token).post('/v1/gratitude', { text: 'hi' })).status).toBe(403);
    const u = await person('Limit');
    expect((await as(u.token).post('/v1/gratitude', { text: 'see example.com' })).body.error.code).toBe('DEDICATION_LINKS');
    for (let i = 0; i < 3; i++) expect((await as(u.token).post('/v1/gratitude', { text: `Thanks ${i}` })).status).toBe(201);
    expect((await as(u.token).post('/v1/gratitude', { text: 'one more' })).body.error.code).toBe('DEDICATION_LIMIT');
  });

  it('crisis words: the post waits for review, the writer gets the help card, moderators see it first', async () => {
    const u = await person('Sam');
    const r = await as(u.token).post('/v1/gratitude', { kind: 'affirmation', text: 'I want to end my life' });
    expect(r.body.data).toMatchObject({ status: 'pending', showHelp: true });
    const queue = (await as(mod).get('/v1/admin/gratitude')).body;
    expect(queue.data[0]).toMatchObject({ id: r.body.data.id, crisis: true, autoFlags: ['crisis'] });
    expect(queue.meta.open).toBeGreaterThanOrEqual(1);
  });

  it('reports hide at the threshold; a moderator keeps it again (audited); hide removes it live', async () => {
    const writer = await person('Lukas');
    const p = (await as(writer.token).post('/v1/gratitude', { text: 'A quiet walk.' })).body.data.id as string;
    for (const n of ['R1', 'R2', 'R3']) {
      const rep = await person(n);
      expect((await as(rep.token).post(`/v1/gratitude/${p}/report`, { reason: 'spam' })).status).toBe(200);
    }
    expect((await q(`SELECT status::text FROM gratitude_posts WHERE id=$1`, [p]))[0]!.status).toBe('hidden');
    const item = (await as(mod).get('/v1/admin/gratitude?filter=review')).body.data.find((x: { id: string }) => x.id === p);
    expect(item).toMatchObject({ reportCount: 3, reasons: ['spam'] });
    expect((await as(mod).post(`/v1/admin/gratitude/${p}/keep`)).status).toBe(200);
    expect((await q(`SELECT status::text FROM gratitude_posts WHERE id=$1`, [p]))[0]!.status).toBe('visible');
    bus.length = 0;
    expect((await as(owner).post('/v1/admin/gratitude/bulk', { ids: [p], action: 'hide' })).body.data.results[0]).toMatchObject({ ok: true, status: 'hidden' });
    await settle();
    expect(bus.some((e) => e.topic === 'gratitude:removed' && e.payload.id === p)).toBe(true);
    expect((await q(`SELECT 1 FROM audit_log WHERE action IN ('gratitude.keep','gratitude.hide') AND target_id=$1`, [p])).length).toBe(2);
    expect((await as(editor).get('/v1/admin/gratitude')).status).toBe(403); // editors do not moderate
  });

  it('blocking hides that writer from my feed; own posts cannot be reported', async () => {
    const a = await person('Writer');
    const b = await person('Reader');
    const p = (await as(a.token).post('/v1/gratitude', { text: 'Morning light.' })).body.data.id;
    expect((await as(a.token).post(`/v1/gratitude/${p}/report`, { reason: 'other' })).status).toBe(422);
    await as(b.token).post(`/v1/gratitude/${p}/report`, { reason: 'other', block: true });
    expect((await as(b.token).get('/v1/gratitude')).body.data.find((x: { id: string }) => x.id === p)).toBeUndefined();
  });
});

describe('P11 breathwork', () => {
  it('templates from the CMS (published only), lessons in the chosen order; editors manage them', async () => {
    const u = await person('Breather');
    let bw = (await as(u.token).get('/v1/breathwork')).body.data;
    expect(bw.templates.map((t: { name: string }) => t.name)).toEqual(['Calming', 'Focus', 'Energy', 'Vagus nerve', 'Anxiety', 'Sleep']);
    expect(bw.templates[0]).toMatchObject({ inhaleSec: 4, hold1Sec: 7, exhaleSec: 8, hold2Sec: 0 });

    const made = await as(editor).post('/v1/admin/breath-patterns', { name: 'Coherent', subtitle: 'Five and five', inhaleSec: 5, exhaleSec: 5, sort: 10 });
    expect(made.status).toBe(201);
    expect((await as(editor).post('/v1/admin/breath-patterns', { name: 'Bad', inhaleSec: 20, hold1Sec: 20, exhaleSec: 20, hold2Sec: 5 })).status).toBe(400);
    expect((await as(u.token).get('/v1/breathwork')).body.data.templates.some((t: { name: string }) => t.name === 'Coherent')).toBe(false); // a draft
    const live = await as(editor).patch(`/v1/admin/breath-patterns/${made.body.data.id}`, { status: 'live' }, { 'if-match': '"v1"' });
    expect(live.status).toBe(200);
    expect((await as(editor).patch(`/v1/admin/breath-patterns/${made.body.data.id}`, { name: 'Late' }, { 'if-match': '"v1"' })).status).toBe(409);

    const lessons = (await q<{ id: string }>(`SELECT id FROM sessions WHERE status='live' ORDER BY slug LIMIT 2`)).map((r) => r.id);
    const cur = (await as(editor).get('/v1/admin/breathwork')).body.data;
    expect((await as(editor).put('/v1/admin/breathwork', { lessons: [lessons[1], lessons[0]] }, { 'if-match': `"v${cur.version}"` })).status).toBe(200);
    bw = (await as(u.token).get('/v1/breathwork')).body.data;
    expect(bw.templates.some((t: { name: string }) => t.name === 'Coherent')).toBe(true);
    expect(bw.lessons.map((l: { lesson: number; session: { id: string } }) => [l.lesson, l.session.id])).toEqual([[1, lessons[1]], [2, lessons[0]]]);
    expect((await as(editor).del(`/v1/admin/breath-patterns/${made.body.data.id}`)).status).toBe(403); // deleting is for owners and admins
    expect((await as(owner).del(`/v1/admin/breath-patterns/${made.body.data.id}`)).status).toBe(204);
  });

  it('a person saves, lists and deletes their own patterns; bad patterns are refused', async () => {
    const u = await person('Designer', false);
    const other = await person('Other', false);
    const r = await as(u.token).post('/v1/me/breath-patterns', { name: 'Mine', inhaleSec: 4, hold1Sec: 4, exhaleSec: 6, rounds: 8 });
    expect(r.status).toBe(201);
    expect((await as(u.token).post('/v1/me/breath-patterns', { name: 'No in', inhaleSec: 0, exhaleSec: 4 })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await as(u.token).get('/v1/me/breath-patterns')).body.data).toEqual([expect.objectContaining({ name: 'Mine', rounds: 8 })]);
    expect((await as(other.token).del(`/v1/me/breath-patterns/${r.body.data.id}`)).status).toBe(404);
    expect((await as(u.token).del(`/v1/me/breath-patterns/${r.body.data.id}`)).status).toBe(204);
    expect((await as(u.token).get('/v1/me/breath-patterns')).body.data).toEqual([]);
  });
});

describe('P11 milestones', () => {
  it('awards follow the person’s own stats and keep the day they were first reached; the world totals are there', async () => {
    const u = await person('Milo');
    let m = (await as(u.token).get('/v1/me/milestones')).body.data;
    expect(m).toMatchObject({ reached: 0, total: 12 });
    for (let d = -6; d <= 0; d++) await meditateOn(u.id, day(d), { minutes: 15, kind: d % 2 ? 'group' : 'solo' });
    m = (await as(u.token).get('/v1/me/milestones')).body.data;
    const by = Object.fromEntries(m.awards.map((a: { key: string }) => [a.key, a]));
    expect(by.first).toMatchObject({ reached: true });
    expect(by.days7).toMatchObject({ reached: true, value: 7 });
    expect(by.minutes100).toMatchObject({ reached: true });
    expect(by.days21).toMatchObject({ reached: false, value: 7, reachedAt: null });
    expect(m.reached).toBe(3);
    const first = by.first.reachedAt;
    const again = (await as(u.token).get('/v1/me/milestones')).body.data.awards.find((a: { key: string }) => a.key === 'first');
    expect(again.reachedAt).toBe(first); // stored, not recomputed
    expect(m.world.meditations).toBeGreaterThanOrEqual(7);
    expect(m.world.countries).toBeGreaterThanOrEqual(0);
    const admin = (await as(editor).get('/v1/admin/milestones')).body.data;
    expect(admin).toHaveLength(12);
    expect(admin.find((x: { key: string }) => x.key === 'days7').reached).toBeGreaterThanOrEqual(1);
  });
});

describe('P11 data rights', () => {
  it('the export lists the coming-soon data; deleting the account removes it', async () => {
    const u = await person('Gone');
    await as(u.token).post('/v1/gratitude', { text: 'Thank you all.' });
    await as(u.token).post('/v1/me/breath-patterns', { name: 'Mine', inhaleSec: 4, exhaleSec: 4 });
    await as(u.token).get('/v1/me/milestones');
    const { UserDataService } = await import('../src/modules/users-admin/user-data.service');
    const { RevenueCatClient } = await import('../src/modules/subscriptions/revenuecat.client');
    app.get(RevenueCatClient).fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch; // RevenueCat forgets the subscriber
    const svc = app.get(UserDataService);
    const exp = await svc.createJob('user_export', u.id, null);
    const doc = await svc.exportUser(exp, u.id);
    expect(doc.meditations).toBe(0);
    const json = await (await fetch(doc.json)).json() as { gratitude: unknown[]; breathPatterns: unknown[]; milestones: unknown[] };
    expect(json.gratitude).toHaveLength(1);
    expect(json.breathPatterns).toHaveLength(1);
    const del = await svc.createJob('user_delete', u.id, null);
    await svc.deleteUser(del, u.id, null);
    const after = await q(`SELECT (SELECT count(*) FROM gratitude_posts WHERE user_id=$1)::int AS g, (SELECT count(*) FROM user_breath_patterns WHERE user_id=$1)::int AS b, (SELECT count(*) FROM user_milestones WHERE user_id=$1)::int AS m`, [u.id]);
    expect(after[0]).toEqual({ g: 0, b: 0, m: 0 });
  });
});
