import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeBus } from '../src/infra/realtime-bus';
import { TokensService } from '../src/modules/auth/tokens.service';
import { crisisHits, hasLink, hasProfanity, normalize } from '../src/modules/community/text-filters';
import { adminToken, bootApp, clearRates, guest, http, makeAdmin, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let owner: string, editor: string, adminTok: string, mod: string, mod2: string;
const q = async <T = Record<string, any>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const bus: { topic: string; payload: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A member with an account (not a guest), who has just finished a meditation. */
async function writer(name = 'Alex', country = 'DE') {
  const g = await guest(app);
  await q(`UPDATE users SET is_guest=false, first_name=$2, country=$3 WHERE id=$1`, [g.me.id, name, country]);
  await q(`INSERT INTO entitlements (user_id, active, product_id, period_type, expires_at) VALUES ($1, true, 'wehum_annual', 'normal', now() + interval '30 days')`, [g.me.id]);
  const token = await app.get(TokensService).tokenFor(g.me.id, undefined, { gst: false, prm: true });
  return { id: g.me.id, token };
}
const session = async () => (await q<{ id: string }>(`SELECT id FROM sessions WHERE status='live' AND NOT is_sos AND type<>'youtube' ORDER BY slug LIMIT 1`))[0]!.id;
async function meditate(userId: string, over: Record<string, unknown> = {}) {
  const id = uuid();
  await q(`INSERT INTO meditations (id, user_id, session_id, kind, started_at, ended_at, duration_sec, counted, completed, local_date) VALUES ($1,$2,$3,'free', now() - interval '20 minutes', now() - interval '1 minute', 1140, $4, $5, (now() at time zone 'utc')::date)`,
    [id, userId, over.sessionId ?? (await session()), over.counted ?? true, over.completed ?? true]);
  return id;
}
const post = (w: { token: string }, meditationId: string, text: string) => http(app).post('/v1/dedications', { meditationId, text }, { token: w.token });
const as = (t: string) => ({
  get: (u: string) => http(app).get(u, { token: t }), post: (u: string, b: unknown = {}) => http(app).post(u, b, { token: t }), put: (u: string, b: unknown = {}) => http(app).put(u, b, { token: t }),
});
const settle = () => new Promise((r) => setTimeout(r, 250));

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const a = await Promise.all((['owner', 'editor', 'admin', 'moderator', 'moderator'] as const).map((r) => makeAdmin(db, r)));
  [owner, editor, adminTok, mod, mod2] = (await Promise.all(a.map((x) => adminToken(app, x)))) as [string, string, string, string, string];
  await app.get(RealtimeBus).subscribe((e) => bus.push(e as never));
});
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P7 text filters', () => {
  it('links, domains, handles and spelled-out dots', () => {
    for (const t of ['see https://x.io', 'go to www.example.org', 'example.com is nice', 'mail me @alex_99', 'example dot com', 'try bit.ly/abc']) expect(hasLink(t), t).toBe(true);
    for (const t of ['I hold this with love.', 'For my mother, who passed in May.', 'Peace & calm... thank you', 'at 5.30 pm today']) expect(hasLink(t), t).toBe(false);
  });
  it('profanity: whole words, leetspeak and spaced letters; no false hits inside other words', () => {
    for (const t of ['this is shit', 'what the f.u.c.k', 'sh1t happens', 'you b!tch', 'F U C K']) expect(hasProfanity(t), t).toBe(true);
    for (const t of ['a classic grassy hill', 'Scunthorpe is a town', 'assistant helps', 'peace']) expect(hasProfanity(t), t).toBe(false);
  });
  it('crisis words from the settings, matched as phrases', () => {
    const words = ['suicide', 'kill myself', 'self harm', 'self-harm'];
    expect(crisisHits('I want to kill myself', words)).toEqual(['kill myself']);
    expect(crisisHits('thinking about SELF-HARM', words).length).toBeGreaterThan(0);
    expect(crisisHits('this was a killer meditation, I felt like myself', words)).toEqual([]);
    expect(normalize('Héllo  W0rld!!')).toBe('hello worldii');
  });
});

describe('P7 posting', () => {
  it('needs a member with an account and a finished meditation of their own', async () => {
    const w = await writer();
    const m = await meditate(w.id);
    const guestUser = await guest(app);
    expect((await http(app).post('/v1/dedications', { meditationId: m, text: 'x' }, { token: guestUser.accessToken })).status).toBe(403);
    const free = await guest(app);
    await q(`UPDATE users SET is_guest=false WHERE id=$1`, [free.me.id]);
    const freeTok = await app.get(TokensService).tokenFor(free.me.id, undefined, { gst: false });
    expect((await post({ token: freeTok }, m, 'x')).body.error.code).toBe('PREMIUM_REQUIRED');
    const other = await writer('Bo');
    expect((await post(other, m, 'not mine')).body.error.code).toBe('MEDITATION_REQUIRED');
    expect((await post(w, await meditate(w.id, { counted: false }), 'too short')).body.error.code).toBe('MEDITATION_REQUIRED');
    expect((await post(w, uuid(), 'unknown')).body.error.code).toBe('MEDITATION_REQUIRED');
    await q(`UPDATE meditations SET ended_at = now() - interval '25 hours' WHERE id=$1`, [m]);
    expect((await post(w, m, 'too old')).body.error.code).toBe('MEDITATION_REQUIRED');
  });

  it('a clean post is visible at once, shows first name + country only, and is announced', async () => {
    const w = await writer('Alex', 'DE');
    const m = await meditate(w.id);
    const r = await post(w, m, '  For my   sister.  ');
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'visible', showHelp: false, dedicationsLeftToday: 2 });
    const [row] = await q(`SELECT * FROM dedications WHERE id=$1`, [r.body.data.id]);
    expect(row).toMatchObject({ text: 'For my sister.', first_name: 'Alex', country: 'DE', status: 'visible' });
    await settle();
    expect(bus.some((e) => e.topic === 'dedication:new' && e.payload.items[0].id === r.body.data.id)).toBe(true);
    expect((await post(w, m, 'again')).body.error.code).toBe('MEDITATION_REQUIRED'); // one per meditation
    const feed = await http(app).get(`/v1/sessions/${row!.session_id}/dedications`, { token: w.token });
    expect(feed.body.data[0]).toMatchObject({ id: r.body.data.id, firstName: 'Alex', country: 'DE', text: 'For my sister.', holdingCount: 0 });
    expect(JSON.stringify(feed.body)).not.toContain(w.id); // no user ids in the feed
  });

  it('text rules: 200 characters, no links or handles, empty is refused', async () => {
    const w = await writer();
    expect((await post(w, await meditate(w.id), 'x'.repeat(201))).status).toBe(400);
    expect((await post(w, await meditate(w.id), '   ')).status).toBe(400);
    const link = await post(w, await meditate(w.id), 'visit www.spam.com');
    expect(link.status).toBe(422);
    expect(link.body.error.code).toBe('DEDICATION_LINKS');
    expect((await post(w, await meditate(w.id), 'x'.repeat(200))).status).toBe(201);
  });

  it('three a day; a refused post does not use one up', async () => {
    const w = await writer();
    for (let i = 0; i < 3; i++) expect((await post(w, await meditate(w.id), `Thank you ${i}`)).status).toBe(201);
    const m4 = await meditate(w.id);
    const r = await post(w, m4, 'one too many');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('DEDICATION_LIMIT');
    expect((await q(`SELECT 1 FROM dedications WHERE meditation_id=$1`, [m4])).length).toBe(0);
    await clearRates();
  });

  it('profanity and crisis posts are accepted but held back; crisis tells the app to show help', async () => {
    const w = await writer();
    const bad = await post(w, await meditate(w.id), 'what the fuck');
    expect(bad.body.data).toMatchObject({ status: 'pending', showHelp: false });
    const crisis = await post(w, await meditate(w.id), 'I want to kill myself');
    expect(crisis.body.data).toMatchObject({ status: 'pending', showHelp: true });
    const rows = await q(`SELECT id, status, auto_flags FROM dedications WHERE id = ANY($1)`, [[bad.body.data.id, crisis.body.data.id]]);
    expect(rows.find((r) => r.id === bad.body.data.id)).toMatchObject({ status: 'flagged', auto_flags: ['profanity'] });
    expect(rows.find((r) => r.id === crisis.body.data.id)).toMatchObject({ status: 'flagged', auto_flags: ['crisis'] });
    await settle();
    expect(bus.filter((e) => e.topic === 'moderation:new').length).toBeGreaterThanOrEqual(2);
    expect(bus.filter((e) => e.topic === 'dedication:new' && [bad.body.data.id, crisis.body.data.id].includes(e.payload.items[0].id))).toHaveLength(0); // never shown
    await clearRates();
  });

  it('a muted writer is accepted but hidden; the settings can switch the filters off', async () => {
    const w = await writer();
    await q(`UPDATE users SET muted_at = now() WHERE id=$1`, [w.id]);
    const r = await post(w, await meditate(w.id), 'hello there');
    expect(r.body.data.status).toBe('pending');
    expect((await q(`SELECT status FROM dedications WHERE id=$1`, [r.body.data.id]))[0]!.status).toBe('hidden');
    expect((await q(`SELECT 1 FROM dedications WHERE id=$1 AND moderated_at IS NULL AND report_count=0`, [r.body.data.id])).length).toBe(1); // not in the review queue
    const w2 = await writer();
    const rules = (await as(owner).get('/v1/admin/moderation/rules')).body.data;
    await as(owner).put('/v1/admin/moderation/rules', { ...rules.value, profanity: false, blockLinks: false });
    expect((await post(w2, await meditate(w2.id), 'shit, see www.a.com')).body.data.status).toBe('visible');
    await as(owner).put('/v1/admin/moderation/rules', rules.value);
    await clearRates();
  });
});

describe('P7 reading, holding, reporting, blocking', () => {
  it('holding is idempotent, counted once per person, announced, and only for visible posts', async () => {
    const w = await writer(); const r = await post(w, await meditate(w.id), 'for all of us');
    const id = r.body.data.id as string;
    const a = await guest(app), b = await guest(app);
    const on = await http(app).put(`/v1/dedications/${id}/hold`, {}, { token: a.accessToken });
    expect(on.body.data).toMatchObject({ holding: true, holdingCount: 1 });
    expect((await http(app).put(`/v1/dedications/${id}/hold`, {}, { token: a.accessToken })).body.data.holdingCount).toBe(1);
    expect((await http(app).put(`/v1/dedications/${id}/hold`, {}, { token: b.accessToken })).body.data.holdingCount).toBe(2);
    const sid = (await q(`SELECT session_id FROM dedications WHERE id=$1`, [id]))[0]!.session_id;
    expect((await http(app).get(`/v1/sessions/${sid}/dedications`, { token: a.accessToken })).body.data.find((d: { id: string }) => d.id === id)).toMatchObject({ holding: true, holdingCount: 2 });
    expect((await http(app).del(`/v1/dedications/${id}/hold`, { token: a.accessToken })).body.data).toMatchObject({ holding: false, holdingCount: 1 });
    expect((await http(app).del(`/v1/dedications/${id}/hold`, { token: a.accessToken })).body.data.holdingCount).toBe(1);
    await settle();
    expect(bus.some((e) => e.topic === 'dedication:holding' && e.payload.id === id && e.payload.holdingCount === 2)).toBe(true);
    await q(`UPDATE dedications SET status='hidden' WHERE id=$1`, [id]);
    expect((await http(app).put(`/v1/dedications/${id}/hold`, {}, { token: a.accessToken })).status).toBe(404);
  });

  it('a report is unique per person; the third hides the post, announces it and puts it in the queue', async () => {
    const w = await writer(); const r = await post(w, await meditate(w.id), 'something questionable');
    const id = r.body.data.id as string;
    const [a, b, c] = await Promise.all([guest(app), guest(app), guest(app)]);
    expect((await http(app).post(`/v1/dedications/${id}/report`, { reason: 'bogus' }, { token: a.accessToken })).status).toBe(400);
    await http(app).post(`/v1/dedications/${id}/report`, { reason: 'spam' }, { token: a.accessToken });
    await http(app).post(`/v1/dedications/${id}/report`, { reason: 'spam' }, { token: a.accessToken }); // same person again
    expect((await q(`SELECT report_count, status FROM dedications WHERE id=$1`, [id]))[0]).toMatchObject({ report_count: 1, status: 'visible' });
    await http(app).post(`/v1/dedications/${id}/report`, { reason: 'abusive' }, { token: b.accessToken });
    await http(app).post(`/v1/dedications/${id}/report`, { reason: 'abusive' }, { token: c.accessToken });
    expect((await q(`SELECT report_count, status FROM dedications WHERE id=$1`, [id]))[0]).toMatchObject({ report_count: 3, status: 'hidden' });
    await settle();
    expect(bus.some((e) => e.topic === 'dedication:removed' && e.payload.id === id)).toBe(true);
    expect(bus.some((e) => e.topic === 'moderation:new' && e.payload.dedication.id === id && e.payload.flags.includes('reports'))).toBe(true);
    const queue = (await as(mod).get('/v1/admin/moderation?filter=review')).body.data;
    expect(queue.find((x: { id: string }) => x.id === id)).toMatchObject({ status: 'hidden', reportCount: 3, reasons: expect.arrayContaining(['spam', 'abusive']) });
    expect((await http(app).post(`/v1/dedications/${id}/report`, { reason: 'spam' }, { token: w.token })).status).toBe(422); // not your own
  });

  it('blocking from a report removes that person from my feed only', async () => {
    const w = await writer('Cleo'); const r = await post(w, await meditate(w.id), 'only a kind word');
    const sid = (await q(`SELECT session_id FROM dedications WHERE id=$1`, [r.body.data.id]))[0]!.session_id;
    const [a, b] = await Promise.all([guest(app), guest(app)]);
    const ids = async (t: string) => (await http(app).get(`/v1/sessions/${sid}/dedications?limit=50`, { token: t })).body.data.map((d: { id: string }) => d.id);
    expect(await ids(a.accessToken)).toContain(r.body.data.id);
    await http(app).post(`/v1/dedications/${r.body.data.id}/report`, { reason: 'other', block: true }, { token: a.accessToken });
    expect(await ids(a.accessToken)).not.toContain(r.body.data.id);
    expect(await ids(b.accessToken)).toContain(r.body.data.id);
  });

  it('paging is by cursor without gaps; the session detail carries the newest three', async () => {
    const sid = await session();
    const feed = async (t: string, cursor?: string) => (await http(app).get(`/v1/sessions/${sid}/dedications?limit=2${cursor ? `&cursor=${cursor}` : ''}`, { token: t })).body;
    const g = await guest(app);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const p = await feed(g.accessToken, cursor);
      seen.push(...p.data.map((d: { id: string }) => d.id));
      cursor = p.meta.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe((await q(`SELECT 1 FROM dedications WHERE session_id=$1 AND status='visible'`, [sid])).length);
    const detail = await http(app).get(`/v1/sessions/${sid}`, { token: g.accessToken });
    expect(detail.body.data.dedications.preview.length).toBeLessThanOrEqual(3);
    expect(detail.body.data.dedications.preview.length).toBeGreaterThan(0);
  });
});

describe('P7 moderation (admin)', () => {
  it('roles: moderators and up read the queue; only owner/admin save rules; editors have no moderation', async () => {
    expect((await as(editor).get('/v1/admin/moderation')).status).toBe(403);
    for (const t of [owner, adminTok, mod]) expect((await as(t).get('/v1/admin/moderation')).status).toBe(200);
    expect((await as(mod).put('/v1/admin/moderation/rules', {})).status).toBe(403);
    expect((await as(mod).get('/v1/admin/moderation/rules')).status).toBe(200);
    expect((await as(owner).put('/v1/admin/moderation/rules', { dailyLimit: 0 })).status).toBe(400);
  });

  it('queue: crisis first, filters, session filter, cursor; stats and count', async () => {
    const all = (await as(mod).get('/v1/admin/moderation?filter=flagged&limit=100')).body;
    expect(all.data.length).toBeGreaterThanOrEqual(2);
    expect(all.data[0].crisis).toBe(true); // priority
    expect(all.data.every((d: { status: string }) => d.status === 'flagged')).toBe(true);
    expect(all.meta.open).toBeGreaterThanOrEqual(all.data.length);
    const p1 = (await as(mod).get('/v1/admin/moderation?filter=all&limit=2')).body;
    const p2 = (await as(mod).get(`/v1/admin/moderation?filter=all&limit=2&cursor=${p1.meta.nextCursor}`)).body;
    expect(p2.data.some((d: { id: string }) => p1.data.some((x: { id: string }) => x.id === d.id))).toBe(false);
    expect((await as(mod).get(`/v1/admin/moderation?filter=all&sessionId=${uuid()}`)).body.data).toEqual([]);
    const stats = (await as(mod).get('/v1/admin/moderation/stats')).body.data;
    expect(stats).toMatchObject({ posts: expect.any(Number), open: expect.any(Number), flagged: expect.any(Number) });
  });

  it('hide and keep: audited, the app is told, bulk reports per item, two moderators cannot double-handle silently', async () => {
    const w = await writer(); const r = await post(w, await meditate(w.id), 'visible then hidden');
    const id = r.body.data.id as string;
    const hide = await as(mod).post(`/v1/admin/moderation/${id}/hide`);
    expect(hide.body.data).toMatchObject({ id, status: 'hidden' });
    await settle();
    expect(bus.some((e) => e.topic === 'dedication:removed' && e.payload.id === id)).toBe(true);
    expect((await q(`SELECT 1 FROM audit_log WHERE action='moderation.hide' AND target_id=$1`, [id])).length).toBe(1);
    const sid = (await q(`SELECT session_id FROM dedications WHERE id=$1`, [id]))[0]!.session_id;
    const g = await guest(app);
    expect((await http(app).get(`/v1/sessions/${sid}/dedications?limit=50`, { token: g.accessToken })).body.data.some((d: { id: string }) => d.id === id)).toBe(false);
    const keep = await as(mod2).post(`/v1/admin/moderation/${id}/keep`);
    expect(keep.body.data.status).toBe('visible');
    expect((await q(`SELECT moderated_by FROM dedications WHERE id=$1`, [id]))[0]!.moderated_by).not.toBeNull();

    const bad = await writer(); const flagged = await post(bad, await meditate(bad.id), 'you bitch');
    const bulk = await as(mod).post('/v1/admin/moderation/bulk', { ids: [flagged.body.data.id, uuid()], action: 'hide' });
    expect(bulk.body.data.results).toEqual([{ id: flagged.body.data.id, ok: true, status: 'hidden' }, { id: expect.any(String), ok: false, error: expect.any(String) }]);
    expect((await as(mod).post(`/v1/admin/moderation/${uuid()}/hide`)).status).toBe(404);
    await clearRates();
  });

  it('keeping a flagged post clears its flags and shows it; the sidebar count follows', async () => {
    const w = await writer(); const r = await post(w, await meditate(w.id), 'what the shit');
    const id = r.body.data.id as string;
    const before = (await as(mod).get('/v1/admin/moderation/stats')).body.data.open;
    await as(mod).post(`/v1/admin/moderation/${id}/keep`);
    expect((await q(`SELECT status, auto_flags FROM dedications WHERE id=$1`, [id]))[0]).toMatchObject({ status: 'visible', auto_flags: [] });
    expect((await as(mod).get('/v1/admin/moderation/stats')).body.data.open).toBe(before - 1);
    await settle();
    expect(bus.filter((e) => e.topic === 'moderation:count').at(-1)!.payload.open).toBe(before - 1);
    await clearRates();
  });

  it('mute: a muted user\'s next posts are hidden; N hides by moderators mute automatically', async () => {
    const w = await writer('Dana');
    expect((await as(mod).post(`/v1/admin/users/${w.id}/mute`, { muted: true })).status).toBe(200);
    expect((await q(`SELECT muted_at FROM users WHERE id=$1`, [w.id]))[0]!.muted_at).not.toBeNull();
    await as(mod).post(`/v1/admin/users/${w.id}/mute`, { muted: false });
    expect((await as(mod).post(`/v1/admin/users/${uuid()}/mute`, {})).status).toBe(404);
    for (let i = 0; i < 3; i++) {
      const p = await post(w, await meditate(w.id), `hello ${i}`);
      const h = await as(mod).post(`/v1/admin/moderation/${p.body.data.id}/hide`);
      expect(h.body.data.autoMuted).toBe(i === 2);
    }
    expect((await q(`SELECT muted_at FROM users WHERE id=$1`, [w.id]))[0]!.muted_at).not.toBeNull();
    expect((await q(`SELECT 1 FROM audit_log WHERE action='user.mute'`)).length).toBeGreaterThanOrEqual(1);
    await clearRates();
  });

  it('deleting a user removes their dedications', async () => {
    const w = await writer(); const r = await post(w, await meditate(w.id), 'gone soon');
    await q(`DELETE FROM users WHERE id=$1`, [w.id]);
    expect((await q(`SELECT 1 FROM dedications WHERE id=$1`, [r.body.data.id])).length).toBe(0);
  });
});
