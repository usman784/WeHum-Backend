import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublishDueService } from '../src/jobs/publish-due.service';
import { YoutubeService } from '../src/modules/admin/content/youtube';
import { adminToken, bootApp, guest, http, makeAdmin, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let owner: string, editor: string, adminTok: string, mod: string;
const A = {
  get: (u: string, t = owner, headers?: Record<string, string>) => http(app).get(u, { token: t, headers }),
  post: (u: string, b: unknown = {}, t = owner, headers?: Record<string, string>) => http(app).post(u, b, { token: t, headers }),
  put: (u: string, b: unknown = {}, t = owner, headers?: Record<string, string>) => http(app).put(u, b, { token: t, headers }),
  patch: (u: string, b: unknown = {}, t = owner, headers?: Record<string, string>) => http(app).patch(u, b, { token: t, headers }),
  del: (u: string, t = owner, headers?: Record<string, string>) => http(app).del(u, { token: t, headers }),
};
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const dayIso = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const catalogVersion = async () => (await q<{ version: number }>(`SELECT version FROM app_config WHERE key='catalog'`))[0]!.version;
const audit = (action: string, id?: string) => q<{ before: unknown; after: unknown; actor_role: string; target_id: string }>(`SELECT * FROM audit_log WHERE action=$1 ${id ? 'AND target_id=$2' : ''} ORDER BY id DESC`, id ? [action, id] : [action]);
const outbox = (topic: string) => q<{ payload: Record<string, unknown> }>(`SELECT payload FROM outbox_events WHERE topic=$1 ORDER BY id DESC`, [topic]);

/** Inserts a media row that looks processed (or not, via status). */
async function readyMedia(kind: 'audio' | 'video' | 'image' = 'audio', durationSec = 600, status = 'ready') {
  const id = uuid();
  await q(`INSERT INTO media_assets (id, kind, storage_key, mime, status, duration_sec, loudness_lufs) VALUES ($1,$2,$3,$4,$5,$6,'-16.00')`,
    [id, kind, `test/${kind}/${id}.bin`, kind === 'image' ? 'image/webp' : 'audio/mp4', status, kind === 'image' ? null : durationSec]);
  return id;
}

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const o = await makeAdmin(db, 'owner'), e = await makeAdmin(db, 'editor'), a = await makeAdmin(db, 'admin'), m = await makeAdmin(db, 'moderator');
  owner = await adminToken(app, o); editor = await adminToken(app, e); adminTok = await adminToken(app, a); mod = await adminToken(app, m);
});
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P3 themes', () => {
  it('create → ETag, audit, outbox, catalog bump; editors may write', async () => {
    const v0 = await catalogVersion();
    const r = await A.post('/v1/admin/themes', { name: 'Gratitude', subtitle: 'Count your blessings' }, editor);
    expect(r.status).toBe(201);
    expect(r.headers.etag).toBe('"v1"');
    expect(r.body.data).toMatchObject({ name: 'Gratitude', slug: 'gratitude', order: 8, visible: true });
    expect(await catalogVersion()).toBe(v0 + 1);
    expect((await audit('theme.create', r.body.data.id))[0]).toMatchObject({ actor_role: 'editor' });
    expect((await outbox('entity:changed'))[0]!.payload).toMatchObject({ type: 'theme', id: r.body.data.id, action: 'theme.create' });
    expect((await outbox('catalog:changed'))[0]!.payload).toEqual({ version: v0 + 1 });
    expect((await A.post('/v1/admin/themes', { name: 'Gratitude' }, editor)).body.data.slug).toMatch(/^gratitude-/); // slug stays unique
  });

  it('validates input and rejects unknown fields', async () => {
    const r = await A.post('/v1/admin/themes', { name: '', color: 'red' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect((await A.post('/v1/admin/themes', { name: 'ok', slug: 'hack' })).status).toBe(400);
    expect((await A.patch('/v1/admin/themes/not-a-uuid', { name: 'x' })).status).toBe(400);
    expect((await A.patch(`/v1/admin/themes/${uuid()}`, { name: 'x' })).status).toBe(404);
  });

  it('If-Match: matching version saves, stale version → 409 CONFLICT_VERSION with the current row, nothing audited', async () => {
    const t = (await A.post('/v1/admin/themes', { name: 'Concurrency' })).body.data;
    const ok = await A.patch(`/v1/admin/themes/${t.id}`, { subtitle: 'first' }, owner, { 'if-match': '"v1"' });
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).toBe('"v2"');
    const before = (await audit('theme.update', t.id)).length;
    const stale = await A.patch(`/v1/admin/themes/${t.id}`, { subtitle: 'second' }, adminTok, { 'if-match': '"v1"' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_VERSION');
    expect(stale.body.error.details.current).toMatchObject({ id: t.id, subtitle: 'first', version: 2 });
    expect((await audit('theme.update', t.id)).length).toBe(before);
    expect((await A.patch(`/v1/admin/themes/${t.id}`, { subtitle: 'x' }, owner, { 'if-match': 'garbage' })).status).toBe(400);
    const log = (await audit('theme.update', t.id))[0]!;
    expect(log.before).toEqual({ subtitle: null });
    expect(log.after).toEqual({ subtitle: 'first' }); // only the changed field is recorded
  });

  it('hidden themes leave the app catalog; reorder needs every theme once', async () => {
    const list = (await A.get('/v1/admin/themes')).body.data as { id: string; visible: boolean; name: string }[];
    const hide = list.find((t) => t.name === 'Concurrency')!;
    await A.patch(`/v1/admin/themes/${hide.id}`, { visible: false });
    const g = await guest(app);
    const cat = await http(app).get('/v1/catalog', { token: g.accessToken });
    expect(cat.body.data.themes.some((t: { id: string }) => t.id === hide.id)).toBe(false);

    const ids = list.map((t) => t.id);
    expect((await A.put('/v1/admin/themes/order', { ids: ids.slice(1) })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await A.put('/v1/admin/themes/order', { ids: [...ids, ids[0]] })).status).toBe(400);
    const rev = [...ids].reverse();
    const r = await A.put('/v1/admin/themes/order', { ids: rev });
    expect(r.status).toBe(200);
    expect(r.body.data.map((t: { id: string }) => t.id)).toEqual(rev);
    expect(r.body.data.map((t: { order: number }) => t.order)).toEqual(rev.map((_, i) => i));
  });

  it('delete: IN_USE until reassigned; reassign moves the sessions', async () => {
    const { id: themeId, n } = (await q<{ id: string; n: number }>(`SELECT theme_id AS id, count(*)::int AS n FROM sessions WHERE theme_id IS NOT NULL GROUP BY theme_id ORDER BY n DESC LIMIT 1`))[0]!;
    const blocked = await A.del(`/v1/admin/themes/${themeId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'IN_USE', details: { sessions: n } });
    const other = (await q<{ id: string }>(`SELECT id FROM themes WHERE id <> $1 LIMIT 1`, [themeId]))[0]!.id;
    expect((await A.del(`/v1/admin/themes/${themeId}?reassignTo=${themeId}`)).status).toBe(400);
    expect((await A.del(`/v1/admin/themes/${themeId}?reassignTo=${uuid()}`)).status).toBe(404);
    expect((await A.del(`/v1/admin/themes/${themeId}?reassignTo=${other}`)).status).toBe(204);
    expect((await q(`SELECT 1 FROM sessions WHERE theme_id=$1`, [other])).length).toBeGreaterThanOrEqual(n);
    expect((await audit('theme.delete', themeId))[0]!.after).toMatchObject({ reassignedTo: other, sessionsMoved: n });
    const empty = (await A.post('/v1/admin/themes', { name: 'Empty' })).body.data.id;
    expect((await A.del(`/v1/admin/themes/${empty}`)).status).toBe(204);
  });
});

describe('P3 teachers', () => {
  it('create + edit with versions; links must be http(s)', async () => {
    const t = await A.post('/v1/admin/teachers', { name: 'Mira Voss', role: 'Breathwork teacher', youtubeUrl: 'https://youtube.com/@mira', canLeadGroup: true });
    expect(t.status).toBe(201);
    expect((await A.post('/v1/admin/teachers', { name: 'Bad', websiteUrl: 'javascript:alert(1)' })).status).toBe(400);
    const p = await A.patch(`/v1/admin/teachers/${t.body.data.id}`, { bio: 'Teaches since 2012.' }, editor, { 'if-match': '"v1"' });
    expect(p.body.data).toMatchObject({ bio: 'Teaches since 2012.', version: 2 });
    expect((await A.patch(`/v1/admin/teachers/${t.body.data.id}`, { bio: 'x' }, editor, { 'if-match': '"v1"' })).status).toBe(409);
    const g = await guest(app);
    const cat = await http(app).get('/v1/catalog', { token: g.accessToken });
    expect(cat.body.data.teachers.map((x: { name: string }) => x.name)).toContain('Mira Voss');
    expect((await A.get('/v1/admin/teachers')).body.data.length).toBeGreaterThanOrEqual(2);
  });
});

describe('P3 sessions', () => {
  it('create draft: validation, YouTube is always free, slug unique', async () => {
    expect((await A.post('/v1/admin/sessions', { type: 'audio' })).status).toBe(400); // title required
    const yt = await A.post('/v1/admin/sessions', { title: 'Free Breath', type: 'youtube', access: 'premium', durationSec: 600 });
    expect(yt.status).toBe(400);
    expect(yt.body.error.details.fields[0].path).toBe('access');
    expect((await A.post('/v1/admin/sessions', { title: 'X', type: 'audio', status: 'live' })).status).toBe(400); // cannot create live
    expect((await A.post('/v1/admin/sessions', { title: 'X', type: 'youtube', youtubeId: 'short' })).status).toBe(400);

    const a = await A.post('/v1/admin/sessions', { title: 'Evening Unwind', type: 'audio', tags: ['Sleep ', 'sleep'], durationSec: 900 }, editor);
    expect(a.status).toBe(201);
    expect(a.headers.etag).toBe('"v1"');
    expect(a.body.data).toMatchObject({ status: 'draft', access: 'premium', slug: 'evening-unwind', version: 1, durationSec: 900 });
    expect(a.body.data.tags).toEqual(['sleep', 'sleep']);
    const b = await A.post('/v1/admin/sessions', { title: 'Evening Unwind', type: 'audio', durationSec: 900 });
    expect(b.body.data.slug).toMatch(/^evening-unwind-/);
    const y = await A.post('/v1/admin/sessions', { title: 'Free Calm Clip', type: 'youtube', youtubeId: 'dQw4w9WgXcQ', durationSec: 300 });
    expect(y.body.data.access).toBe('free');
  });

  it('draft edits do not touch the catalog; every edit is versioned and audited', async () => {
    const s = (await A.post('/v1/admin/sessions', { title: 'Draft Only', type: 'audio', durationSec: 600 })).body.data;
    const v0 = await catalogVersion();
    const p = await A.patch(`/v1/admin/sessions/${s.id}`, { description: 'Hello' }, editor, { 'if-match': '"v1"' });
    expect(p.body.data).toMatchObject({ description: 'Hello', version: 2 });
    expect(await catalogVersion()).toBe(v0); // drafts are invisible to the app
    expect((await A.patch(`/v1/admin/sessions/${s.id}`, { title: 'Late' }, owner, { 'if-match': '"v1"' })).body.error.code).toBe('CONFLICT_VERSION');
    expect((await A.patch(`/v1/admin/sessions/${s.id}`, { access: 'free', type: 'youtube' })).body.data).toMatchObject({ type: 'youtube', access: 'free' });
    expect((await A.patch(`/v1/admin/sessions/${s.id}`, { status: 'live' })).status).toBe(400); // status only via publish/schedule/archive
    expect((await audit('session.update', s.id))).toHaveLength(2);
  });

  it('publish needs processed media (MEDIA_NOT_READY), then goes live and bumps the catalog', async () => {
    const s = (await A.post('/v1/admin/sessions', { title: 'Needs Media', type: 'audio', durationSec: 600 })).body.data;
    const none = await A.post(`/v1/admin/sessions/${s.id}/publish`);
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('MEDIA_NOT_READY');
    const processing = await readyMedia('audio', 0, 'processing');
    await A.patch(`/v1/admin/sessions/${s.id}`, { mediaId: processing });
    expect((await A.post(`/v1/admin/sessions/${s.id}/publish`)).body.error.code).toBe('MEDIA_NOT_READY');
    const media = await readyMedia('audio', 1234);
    await A.patch(`/v1/admin/sessions/${s.id}`, { mediaId: media });
    const g = await guest(app);
    const before = await http(app).get('/v1/catalog', { token: g.accessToken });
    expect(before.body.data.sessions.some((x: { id: string }) => x.id === s.id)).toBe(false);

    const v0 = await catalogVersion();
    const pub = await A.post(`/v1/admin/sessions/${s.id}/publish`, {}, editor);
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ status: 'live', durationSec: 1234 }); // duration comes from the file
    expect(await catalogVersion()).toBe(v0 + 1);
    const after = await http(app).get('/v1/catalog', { token: g.accessToken });
    expect(after.body.data.sessions.find((x: { id: string }) => x.id === s.id)).toMatchObject({ title: 'Needs Media', durationSec: 1234 });
    expect(after.body.meta.version).toBe(v0 + 1);
    expect((await A.post(`/v1/admin/sessions/${s.id}/publish`)).body.error.code).toBe('INVALID_STATE');
    expect((await audit('session.publish', s.id))[0]!.after).toEqual({ status: 'live' });
  });

  it('YouTube items publish with just the video id', async () => {
    const s = (await A.post('/v1/admin/sessions', { title: 'Needs Link', type: 'youtube', durationSec: 600 })).body.data;
    expect((await A.post(`/v1/admin/sessions/${s.id}/publish`)).status).toBe(400);
    await A.patch(`/v1/admin/sessions/${s.id}`, { youtubeId: 'abcdefghijk' });
    expect((await A.post(`/v1/admin/sessions/${s.id}/publish`)).body.data.status).toBe('live');
  });

  it('schedule: future only; stays hidden until publishDue runs; then one catalog bump', async () => {
    const media = await readyMedia();
    const s = (await A.post('/v1/admin/sessions', { title: 'Scheduled One', type: 'audio', mediaId: media, durationSec: 600 })).body.data;
    expect((await A.post(`/v1/admin/sessions/${s.id}/schedule`, { publishAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await A.post(`/v1/admin/sessions/${s.id}/schedule`, { publishAt: 'tomorrow' })).status).toBe(400);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const r = await A.post(`/v1/admin/sessions/${s.id}/schedule`, { publishAt: at });
    expect(r.body.data).toMatchObject({ status: 'scheduled' });

    const svc = app.get(PublishDueService);
    expect(await svc.run()).toBe(0); // not due yet
    await q(`UPDATE sessions SET publish_at = now() - interval '1 minute' WHERE id=$1`, [s.id]);
    const v0 = await catalogVersion();
    expect(await svc.run()).toBe(1);
    expect(await catalogVersion()).toBe(v0 + 1);
    expect((await q<{ status: string }>(`SELECT status FROM sessions WHERE id=$1`, [s.id]))[0]!.status).toBe('live');
    expect((await audit('session.publish', s.id))[0]).toMatchObject({ actor_role: 'system' });
    const g = await guest(app);
    expect((await http(app).get('/v1/catalog', { token: g.accessToken })).body.data.sessions.some((x: { id: string }) => x.id === s.id)).toBe(true);
    expect(await svc.run()).toBe(0); // idempotent

    // a due session whose media is gone is left alone, not published broken
    const broken = (await A.post('/v1/admin/sessions', { title: 'Broken Due', type: 'audio', mediaId: await readyMedia(), durationSec: 600 })).body.data;
    await A.post(`/v1/admin/sessions/${broken.id}/schedule`, { publishAt: new Date(Date.now() + 3_600_000).toISOString() });
    await q(`UPDATE media_assets SET status='failed' WHERE id=(SELECT media_id FROM sessions WHERE id=$1)`, [broken.id]);
    await q(`UPDATE sessions SET publish_at = now() - interval '1 minute' WHERE id=$1`, [broken.id]);
    expect(await svc.run()).toBe(0);
    expect((await q<{ status: string }>(`SELECT status FROM sessions WHERE id=$1`, [broken.id]))[0]!.status).toBe('scheduled');
  });

  it('archive: blocked while it is a future meditation of the day, otherwise leaves the catalog', async () => {
    const live = (await q<{ id: string }>(`SELECT id FROM sessions WHERE status='live' AND NOT is_sos AND access='premium' AND id NOT IN (SELECT session_id FROM motd_days) ORDER BY slug LIMIT 1`))[0]!.id;
    await q(`INSERT INTO motd_days (date, session_id) VALUES ($1,$2) ON CONFLICT (date) DO UPDATE SET session_id=$2`, [dayIso(5), live]);
    const blocked = await A.post(`/v1/admin/sessions/${live}/archive`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'IN_USE', details: { motdDates: expect.arrayContaining([dayIso(5)]) } });
    const detail = await A.get(`/v1/admin/sessions/${live}`);
    expect(detail.body.data.usage.motdDates).toContain(dayIso(5));
    expect(detail.headers.etag).toMatch(/^"v\d+"$/);
    await q(`DELETE FROM motd_days WHERE date=$1`, [dayIso(5)]);
    const ok = await A.post(`/v1/admin/sessions/${live}/archive`);
    expect(ok.body.data.status).toBe('archived');
    const g = await guest(app);
    expect((await http(app).get('/v1/catalog', { token: g.accessToken })).body.data.sessions.some((x: { id: string }) => x.id === live)).toBe(false);
    expect((await A.post(`/v1/admin/sessions/${live}/archive`)).body.error.code).toBe('INVALID_STATE');
  });

  it('duplicate → fresh draft; delete only drafts and only for owner/admin', async () => {
    const src = (await q<{ id: string; title: string }>(`SELECT id, title FROM sessions WHERE status='live' AND NOT is_sos ORDER BY slug LIMIT 1`))[0]!;
    const d = await A.post(`/v1/admin/sessions/${src.id}/duplicate`, {}, editor);
    expect(d.status).toBe(201);
    expect(d.body.data).toMatchObject({ title: `${src.title} (copy)`, status: 'draft', plays: 0, version: 1, publishAt: null });
    expect(d.body.data.id).not.toBe(src.id);
    expect((await A.del(`/v1/admin/sessions/${d.body.data.id}`, editor)).status).toBe(403);
    expect((await A.del(`/v1/admin/sessions/${src.id}`, adminTok)).body.error.code).toBe('INVALID_STATE'); // live
    expect((await A.del(`/v1/admin/sessions/${d.body.data.id}`, adminTok)).status).toBe(204);
    expect((await A.del(`/v1/admin/sessions/${d.body.data.id}`, adminTok)).status).toBe(404);
    // a draft that a program uses cannot be deleted
    const dd = (await A.post('/v1/admin/sessions', { title: 'In A Program', type: 'audio', durationSec: 300 })).body.data;
    const prog = (await q<{ id: string }>(`SELECT id FROM programs LIMIT 1`))[0]!.id;
    await q(`INSERT INTO program_days (program_id, day, session_id) VALUES ($1, 99, $2)`, [prog, dd.id]);
    expect((await A.del(`/v1/admin/sessions/${dd.id}`)).body.error.code).toBe('IN_USE');
    await q(`DELETE FROM program_days WHERE day=99`);
  });

  it('list: tabs, filters, search and keyset pagination without gaps or repeats (all sorts)', async () => {
    const total = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM sessions`))[0]!.n;
    for (const sort of ['updated', 'title', 'plays', 'published']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 30; guard++) {
        const r = await A.get(`/v1/admin/sessions?sort=${sort}&limit=7${cursor ? `&cursor=${cursor}` : ''}`);
        expect(r.status).toBe(200);
        seen.push(...r.body.data.map((s: { id: string }) => s.id));
        cursor = r.body.meta.nextCursor;
        if (!cursor) break;
      }
      expect(seen.length, `${sort}: total`).toBe(total);
      expect(new Set(seen).size, `${sort}: no repeats`).toBe(total);
    }
    const byPlays = (await A.get('/v1/admin/sessions?sort=plays&limit=100')).body.data.map((s: { plays: number }) => s.plays);
    expect(byPlays).toEqual([...byPlays].sort((a: number, b: number) => b - a));
    const drafts = await A.get('/v1/admin/sessions?tab=drafts&limit=100');
    expect(drafts.body.data.length).toBeGreaterThan(0);
    expect(drafts.body.data.every((s: { status: string }) => s.status === 'draft')).toBe(true);
    expect((await A.get('/v1/admin/sessions?tab=scheduled')).body.data.every((s: { status: string }) => s.status === 'scheduled')).toBe(true);
    const free = await A.get('/v1/admin/sessions?access=free&type=youtube&limit=100');
    expect(free.body.data.every((s: { access: string; type: string }) => s.access === 'free' && s.type === 'youtube')).toBe(true);
    const found = await A.get('/v1/admin/sessions?q=evening');
    expect(found.body.data.map((s: { title: string }) => s.title.toLowerCase()).every((t: string) => t.includes('evening'))).toBe(true);
    expect((await A.get('/v1/admin/sessions?q=%25')).body.data).toEqual([]);
    expect((await A.get('/v1/admin/sessions?sort=nope')).status).toBe(400);
    expect((await A.get('/v1/admin/sessions?cursor=!!!')).status).toBe(200); // a bad cursor just starts from the top
  });

  it('bulk: per-item results, one bad item does not stop the rest', async () => {
    const media = await readyMedia();
    const ok = (await A.post('/v1/admin/sessions', { title: 'Bulk OK', type: 'audio', mediaId: media, durationSec: 60 })).body.data.id as string;
    const noMedia = (await A.post('/v1/admin/sessions', { title: 'Bulk No Media', type: 'audio', durationSec: 60 })).body.data.id as string;
    const r = await A.post('/v1/admin/sessions/bulk', { action: 'publish', ids: [noMedia, ok, uuid()] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ok: 1, failed: 2 });
    expect(r.body.data.results.map((x: { ok: boolean; error?: { code: string } }) => x.error?.code ?? 'ok')).toEqual(['MEDIA_NOT_READY', 'ok', 'NOT_FOUND']);
    const theme = (await q<{ id: string }>(`SELECT id FROM themes LIMIT 1`))[0]!.id;
    const mv = await A.post('/v1/admin/sessions/bulk', { action: 'changeTheme', ids: [ok], themeId: theme });
    expect(mv.body.data.ok).toBe(1);
    expect((await q<{ theme_id: string }>(`SELECT theme_id FROM sessions WHERE id=$1`, [ok]))[0]!.theme_id).toBe(theme);
    expect((await A.post('/v1/admin/sessions/bulk', { action: 'changeTheme', ids: [ok] })).status).toBe(400);
    const arch = await A.post('/v1/admin/sessions/bulk', { action: 'archive', ids: [ok] });
    expect(arch.body.data.ok).toBe(1);
  });

  it('YouTube resolve: id parsing, private → 422, outage → 503, duration from the API', async () => {
    const real = YoutubeService.fetchImpl;
    try {
      const calls: string[] = [];
      YoutubeService.fetchImpl = (async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('private000')) return new Response('', { status: 401 });
        if (String(url).includes('down00000')) throw new Error('ECONNRESET');
        return new Response(JSON.stringify({ title: 'Ten Minutes of Calm', thumbnail_url: 'https://i.ytimg.com/vi/x/hq.jpg' }), { status: 200 });
      }) as typeof fetch;
      const ok = await A.post('/v1/admin/youtube/resolve', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9s' }, editor);
      expect(ok.body.data).toMatchObject({ youtubeId: 'dQw4w9WgXcQ', title: 'Ten Minutes of Calm', durationSec: null });
      for (const u of ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ']) {
        expect((await A.post('/v1/admin/youtube/resolve', { url: u })).body.data.youtubeId, u).toBe('dQw4w9WgXcQ');
      }
      expect((await A.post('/v1/admin/youtube/resolve', { url: 'https://vimeo.com/123' })).status).toBe(400);
      expect((await A.post('/v1/admin/youtube/resolve', { url: 'https://evil.example/watch?v=dQw4w9WgXcQ' })).status).toBe(400);
      const priv = await A.post('/v1/admin/youtube/resolve', { url: 'private0000' });
      expect(priv.status).toBe(422);
      expect(priv.body.error.code).toBe('YOUTUBE_UNAVAILABLE');
      const down = await A.post('/v1/admin/youtube/resolve', { url: 'down00000aa' });
      expect(down.status).toBe(503);
      expect(down.body.error.code).toBe('DEPENDENCY_DOWN');
      expect(calls.every((c) => c.startsWith('https://www.youtube.com/oembed'))).toBe(true);
    } finally { YoutubeService.fetchImpl = real; }
    const { isoDurationSec } = await import('../src/modules/admin/content/youtube');
    expect(isoDurationSec('PT1H2M3S')).toBe(3723);
    expect(isoDurationSec('PT45S')).toBe(45);
    expect(isoDurationSec('PT10M')).toBe(600);
  });
});

describe('P3 sound blocks + SoS', () => {
  it('sound block takes duration + loudness from the processed file', async () => {
    const media = await readyMedia('audio', 42);
    const r = await A.post('/v1/admin/sound-blocks', { kind: 'bell', name: 'Gong', mediaId: media });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ kind: 'bell', durationSec: 42, loudnessLufs: '-16.00', access: 'premium', loopable: false });
    expect((await A.post('/v1/admin/sound-blocks', { kind: 'bell', name: 'Bad', mediaId: await readyMedia('audio', 5, 'processing') })).body.error.code).toBe('MEDIA_NOT_READY');
    expect((await A.post('/v1/admin/sound-blocks', { kind: 'bell', name: 'Bad', mediaId: await readyMedia('image') })).status).toBe(400);
    expect((await A.post('/v1/admin/sound-blocks', { kind: 'bell', name: 'Bad', mediaId: uuid() })).status).toBe(404);
    expect((await A.post('/v1/admin/sound-blocks', { kind: 'nope', name: 'Bad', mediaId: media })).status).toBe(400);
    const p = await A.patch(`/v1/admin/sound-blocks/${r.body.data.id}`, { name: 'Big Gong', visible: false }, editor, { 'if-match': '"v1"' });
    expect(p.body.data).toMatchObject({ name: 'Big Gong', visible: false, version: 2 });
    const g = await guest(app);
    expect((await http(app).get('/v1/catalog', { token: g.accessToken })).body.data.soundBlocks.some((b: { id: string }) => b.id === r.body.data.id)).toBe(false);
    expect((await A.get('/v1/admin/sound-blocks?kind=bell')).body.data.every((b: { kind: string }) => b.kind === 'bell')).toBe(true);
  });

  it('reorder sound blocks', async () => {
    const list = (await A.get('/v1/admin/sound-blocks?kind=sound')).body.data as { id: string }[];
    const rev = [...list].reverse().map((b) => b.id);
    const r = await A.put('/v1/admin/sound-blocks/order', { ids: rev });
    expect(r.status).toBe(200);
    expect((await A.get('/v1/admin/sound-blocks?kind=sound')).body.data.map((b: { id: string }) => b.id)).toEqual(rev);
    expect((await A.put('/v1/admin/sound-blocks/order', { ids: [uuid()] })).status).toBe(404);
  });

  it('SoS: header + help card validated, tiles max 8, app sees the change after the bump', async () => {
    const cur = await A.get('/v1/admin/sos');
    expect(cur.body.data.tiles).toHaveLength(8);
    expect(cur.headers.etag).toMatch(/^"v\d+"$/);
    const bad = await A.put('/v1/admin/sos', { title: 'Hi', subtitle: '', help: { title: 'Help', body: 'x', bookingUrl: 'not a url', contactEmail: 'a@b.co' } });
    expect(bad.status).toBe(400);
    const good = { title: 'Need a moment?', subtitle: 'Pick what you feel.', help: { title: 'More help', body: 'Book Raphael.', bookingUrl: 'https://wehum.app/book', contactEmail: 'help@wehum.app' } };
    const v0 = await catalogVersion();
    const ok = await A.put('/v1/admin/sos', good, editor, { 'if-match': cur.headers.etag as string });
    expect(ok.status).toBe(200);
    expect(await catalogVersion()).toBe(v0 + 1);
    expect((await A.put('/v1/admin/sos', good, editor, { 'if-match': cur.headers.etag as string })).body.error.code).toBe('CONFLICT_VERSION');
    const g = await guest(app);
    const app1 = await http(app).get('/v1/sos', { token: g.accessToken });
    expect(app1.body.data.title).toBe('Need a moment?');

    const tiles = (cur.body.data.tiles as { sessionId: string }[]).map((t) => t.sessionId);
    const order = [...tiles].reverse().slice(0, 5);
    const r = await A.put('/v1/admin/sos/order', { ids: order });
    expect(r.body.data.tiles.map((t: { sessionId: string }) => t.sessionId)).toEqual(order);
    const app2 = await http(app).get('/v1/sos', { token: g.accessToken });
    expect(app2.body.data.tiles.map((t: { sessionId: string }) => t.sessionId)).toEqual(order);
    expect((await A.put('/v1/admin/sos/order', { ids: Array.from({ length: 9 }, () => uuid()) })).status).toBe(400);
    expect((await A.put('/v1/admin/sos/order', { ids: [uuid()] })).status).toBe(404);
  });
});

describe('P3 programs + challenges', () => {
  it('program lifecycle: draft → days → live → in the catalog; KPIs', async () => {
    const p = await A.post('/v1/admin/programs', { title: 'Ten Days of Stillness', description: 'Slow down.' });
    expect(p.status).toBe(201);
    expect(p.body.data).toMatchObject({ status: 'draft', slug: 'ten-days-of-stillness', days: [], kpis: { started: 0, completed: 0 } });
    const id = p.body.data.id as string;
    expect((await A.patch(`/v1/admin/programs/${id}`, { status: 'live' })).body.error.code).toBe('INVALID_STATE'); // no days yet

    const ss = await q<{ id: string }>(`SELECT id FROM sessions WHERE status='live' AND NOT is_sos ORDER BY slug LIMIT 3`);
    const gap = await A.put(`/v1/admin/programs/${id}/days`, { days: [{ day: 1, sessionId: ss[0]!.id }, { day: 3, sessionId: ss[1]!.id }] });
    expect(gap.status).toBe(400);
    expect((await A.put(`/v1/admin/programs/${id}/days`, { days: [{ day: 1, sessionId: uuid() }] })).status).toBe(404);
    const v = await A.put(`/v1/admin/programs/${id}/days`, { days: ss.map((s, i) => ({ day: i + 1, sessionId: s.id, title: `Day ${i + 1}` })) }, editor);
    expect(v.status).toBe(200);
    expect(v.body.data.days).toHaveLength(3);
    expect(v.headers.etag).toBe('"v2"');
    const live = await A.patch(`/v1/admin/programs/${id}`, { status: 'live' }, editor, { 'if-match': v.headers.etag as string });
    expect(live.body.data.status).toBe('live');
    const g = await guest(app);
    const cat = await http(app).get('/v1/catalog', { token: g.accessToken });
    expect(cat.body.data.programs.find((x: { id: string }) => x.id === id).days).toHaveLength(3);

    await q(`INSERT INTO program_progress (user_id, program_id, completed_days, completed_at) VALUES ($1,$2,'{1,2,3}', now())`, [g.me.id, id]);
    const list = await A.get('/v1/admin/programs');
    expect(list.body.data.find((x: { id: string }) => x.id === id).kpis).toEqual({ started: 1, completed: 1 });
    // replacing days with fewer
    const two = await A.put(`/v1/admin/programs/${id}/days`, { days: [{ day: 1, sessionId: ss[2]!.id }] });
    expect(two.body.data.days.map((d: { sessionId: string }) => d.sessionId)).toEqual([ss[2]!.id]);
    expect((await audit('program.days', id))[0]!.before).toEqual({ days: ss.map((s) => s.id) });
  });

  it('challenges (coming soon): create, edit, list with participants', async () => {
    const c = await A.post('/v1/admin/challenges', { name: '7 Days Together', days: 7, counts: 'group', startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ days: 7, counts: 'group', minMinutes: 3, membersOnly: true, status: 'draft' });
    expect((await A.post('/v1/admin/challenges', { name: 'x', days: 0 })).status).toBe(400);
    const p = await A.patch(`/v1/admin/challenges/${c.body.data.id}`, { status: 'scheduled', minMinutes: 5 }, editor, { 'if-match': '"v1"' });
    expect(p.body.data).toMatchObject({ status: 'scheduled', minMinutes: 5, version: 2 });
    const g = await guest(app);
    await q(`INSERT INTO challenge_participants (challenge_id, user_id) VALUES ($1,$2)`, [c.body.data.id, g.me.id]);
    expect((await A.get('/v1/admin/challenges')).body.data.find((x: { id: string }) => x.id === c.body.data.id).participants).toBe(1);
    const v0 = await catalogVersion();
    await A.patch(`/v1/admin/challenges/${c.body.data.id}`, { name: 'Renamed' });
    expect(await catalogVersion()).toBe(v0); // not part of the app catalog yet
  });
});

describe('P3 daily messages', () => {
  it('upsert per day, rules for going live, delete; members see it in the app', async () => {
    const d = dayIso(-20);
    const text = await A.put(`/v1/admin/daily-messages/${d}`, { type: 'text', title: 'On stillness', text: 'Sit with it.', themeTag: 'Mindfulness', status: 'live' }, editor);
    expect(text.status).toBe(200);
    expect(text.headers.etag).toBe('"v1"');
    const edit = await A.put(`/v1/admin/daily-messages/${d}`, { type: 'text', title: 'On stillness', text: 'Sit with it. Again.', status: 'live' }, editor, { 'if-match': '"v1"' });
    expect(edit.body.data.version).toBe(2);
    expect((await A.put(`/v1/admin/daily-messages/${d}`, { type: 'text', title: 'x', text: 'y', status: 'live' }, editor, { 'if-match': '"v1"' })).body.error.code).toBe('CONFLICT_VERSION');
    expect((await A.put(`/v1/admin/daily-messages/${d}`, { type: 'text', title: 'x', status: 'live' })).status).toBe(400); // live text needs text
    expect((await A.put(`/v1/admin/daily-messages/${dayIso(-21)}`, { type: 'audio', title: 'x', status: 'live' })).status).toBe(400); // live audio needs media
    expect((await A.put(`/v1/admin/daily-messages/${dayIso(-21)}`, { type: 'audio', title: 'x', mediaId: await readyMedia('audio', 5, 'processing'), status: 'draft' })).body.error.code).toBe('MEDIA_NOT_READY');
    expect((await A.put('/v1/admin/daily-messages/2026-02-30', { type: 'text', title: 'x' })).status).toBe(400);
    const audioDay = dayIso(-22);
    expect((await A.put(`/v1/admin/daily-messages/${audioDay}`, { type: 'audio', title: 'Listen', mediaId: await readyMedia('audio', 90), durationSec: 90, status: 'live' })).status).toBe(200);

    const range = await A.get(`/v1/admin/daily-messages?from=${dayIso(-30)}&to=${dayIso(-15)}`);
    expect(range.body.data.map((m: { date: string }) => m.date)).toEqual(expect.arrayContaining([d, audioDay]));
    expect((await A.get(`/v1/admin/daily-messages?from=${dayIso(0)}&to=${dayIso(-1)}`)).status).toBe(400);
    expect((await A.get(`/v1/admin/daily-messages?from=2020-01-01&to=2026-12-31`)).status).toBe(400);
    expect((await A.get('/v1/admin/daily-messages')).status).toBe(200); // defaults to this month

    const member = await guest(app);
    await q(`INSERT INTO entitlements (user_id, active, expires_at) VALUES ($1, true, now() + interval '1 day')`, [member.me.id]);
    const app1 = await http(app).get(`/v1/daily-messages/${d}`, { token: member.accessToken });
    expect(app1.body.data).toMatchObject({ date: d, title: 'On stillness', text: 'Sit with it. Again.' });
    expect((await A.del(`/v1/admin/daily-messages/${d}`, editor)).status).toBe(204);
    expect((await A.del(`/v1/admin/daily-messages/${d}`, editor)).status).toBe(404);
    expect((await audit('dailyMessage.delete', d))[0]!.before).toMatchObject({ title: 'On stillness' });
  });

  it('scheduled messages go live on their day (publishDue), future ones wait, empty ones are left alone', async () => {
    const svc = app.get(PublishDueService);
    const past = dayIso(-40), future = dayIso(30), empty = dayIso(-41);
    for (const d of [past, future]) {
      expect((await A.put(`/v1/admin/daily-messages/${d}`, { type: 'text', title: `Sched ${d}`, text: 'Hello.', status: 'scheduled' })).status).toBe(200);
    }
    expect((await A.put(`/v1/admin/daily-messages/${empty}`, { type: 'text', title: 'Empty', status: 'scheduled' })).status).toBe(200); // a draft-like schedule is allowed; going live needs text
    const status = async (d: string) => (await q<{ status: string }>(`SELECT status FROM daily_messages WHERE date=$1`, [d]))[0]!.status;
    expect(await svc.publishMessages()).toBe(1);
    expect(await status(past)).toBe('live');
    expect(await status(future)).toBe('scheduled');
    expect(await status(empty)).toBe('scheduled');
    expect((await audit('dailyMessage.publish', past))[0]).toMatchObject({ actor_role: 'system' });
    expect(await svc.publishMessages()).toBe(0); // idempotent
    await q(`DELETE FROM daily_messages WHERE date = ANY($1)`, [[past, future, empty]]);
  });
});

describe('P3 Today screen: MOTD + group + config', () => {
  it('range lists every day with variant status and completeness', async () => {
    const r = await A.get(`/v1/admin/motd?from=${dayIso(0)}&to=${dayIso(6)}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(7);
    expect(r.body.data[0]).toMatchObject({ date: dayIso(0), complete: true, variants: { 10: { status: 'ready' }, 30: { status: 'ready' }, 45: { status: 'ready' } } });
    expect((await A.get('/v1/admin/motd')).body.data).toHaveLength(15); // default: today + 14 days
    expect((await A.get('/v1/admin/motd?from=2026-01-01&to=2027-01-01')).status).toBe(400);
    expect((await A.get('/v1/admin/motd?from=garbage')).status).toBe(400);
  });

  it('set / variants / swap: past is locked, media must be ready audio, the app sees changes at once', async () => {
    const day = dayIso(20), day2 = dayIso(21);
    const [s1, s2] = await q<{ id: string }>(`SELECT id FROM sessions WHERE status='live' AND NOT is_sos AND type='audio' ORDER BY slug LIMIT 2 OFFSET 5`);
    expect((await A.put(`/v1/admin/motd/${dayIso(-1)}`, { sessionId: s1!.id })).body.error.code).toBe('INVALID_STATE');
    expect((await A.put(`/v1/admin/motd/${day}`, { sessionId: uuid() })).status).toBe(404);
    const draft = (await A.post('/v1/admin/sessions', { title: 'MOTD Draft', type: 'audio', durationSec: 100 })).body.data.id;
    expect((await A.put(`/v1/admin/motd/${day}`, { sessionId: draft })).body.error.code).toBe('INVALID_STATE'); // must be published
    const yt = (await q<{ id: string }>(`SELECT id FROM sessions WHERE type='youtube' LIMIT 1`))[0]!.id;
    expect((await A.put(`/v1/admin/motd/${day}`, { sessionId: yt })).body.error.code).toBe('INVALID_STATE'); // free library items are never the MOTD
    expect((await A.put(`/v1/admin/motd/${day}/variants/30`, { mediaId: await readyMedia() })).body.error.code).toBe('INVALID_STATE'); // day not set yet

    const set = await A.put(`/v1/admin/motd/${day}`, { sessionId: s1!.id, groupStartUtc: '18:30', groupLengthMin: 45 }, editor);
    expect(set.status).toBe(200);
    expect(set.headers.etag).toBe('"v1"');
    const g = await guest(app);
    const seen = await http(app).get(`/v1/motd/${dayIso(1)}`, { token: g.accessToken }); // day 20 is beyond "tomorrow": app never sees it
    expect(seen.body.data.date).toBe(dayIso(1));

    const m10 = await readyMedia('audio', 600), m30 = await readyMedia('audio', 1800);
    expect((await A.put(`/v1/admin/motd/${day}/variants/20`, { mediaId: m10 })).status).toBe(400);
    expect((await A.put(`/v1/admin/motd/${day}/variants/10`, { mediaId: await readyMedia('image') })).status).toBe(400);
    expect((await A.put(`/v1/admin/motd/${day}/variants/10`, { mediaId: await readyMedia('audio', 5, 'processing') })).body.error.code).toBe('MEDIA_NOT_READY');
    expect((await A.put(`/v1/admin/motd/${day}/variants/10`, { mediaId: m10 })).status).toBe(200);
    expect((await A.put(`/v1/admin/motd/${day}/variants/30`, { mediaId: m30 })).status).toBe(200);
    const row = (await A.get(`/v1/admin/motd?from=${day}&to=${day}`)).body.data[0];
    expect(row).toMatchObject({ sessionId: s1!.id, groupStartUtc: '18:30', groupLengthMin: 45, complete: false, variants: { 10: { status: 'ready', durationSec: 600 }, 30: { durationSec: 1800 }, 45: null } });

    await A.put(`/v1/admin/motd/${day2}`, { sessionId: s2!.id });
    const sw = await A.post('/v1/admin/motd/swap', { a: day, b: day2 }, editor);
    expect(sw.status).toBe(200);
    expect(sw.body.data.map((d: { date: string; sessionId: string }) => [d.date, d.sessionId])).toEqual([[day, s2!.id], [day2, s1!.id]]);
    const after = (await A.get(`/v1/admin/motd?from=${day2}&to=${day2}`)).body.data[0];
    expect(after).toMatchObject({ groupStartUtc: '18:30', variants: { 10: { durationSec: 600 }, 30: { durationSec: 1800 } } }); // variants travel with the day
    expect((await A.get(`/v1/admin/motd?from=${day}&to=${day}`)).body.data[0].variants).toEqual({ 10: null, 30: null, 45: null });
    expect((await A.post('/v1/admin/motd/swap', { a: day, b: day })).status).toBe(400);
    expect((await A.post('/v1/admin/motd/swap', { a: day, b: dayIso(30) })).status).toBe(404);
    expect((await A.post('/v1/admin/motd/swap', { a: dayIso(-1), b: day })).body.error.code).toBe('INVALID_STATE');
    expect((await audit('motd.swap'))[0]!.after).toEqual({ [day]: s2!.id, [day2]: s1!.id });
  });

  it('changing the MOTD of tomorrow shows in the app immediately (cache dropped)', async () => {
    const tomorrow = dayIso(1);
    const g = await guest(app);
    const first = await http(app).get(`/v1/motd/${tomorrow}`, { token: g.accessToken }); // fills the cache
    const [other] = await q<{ id: string; title: string }>(`SELECT id, title FROM sessions WHERE status='live' AND NOT is_sos AND type='audio' AND id <> $1 ORDER BY slug LIMIT 1`, [first.body.data.sessionId]);
    expect((await A.put(`/v1/admin/motd/${tomorrow}`, { sessionId: other!.id })).status).toBe(200);
    const second = await http(app).get(`/v1/motd/${tomorrow}`, { token: g.accessToken });
    expect(second.body.data.sessionId).toBe(other!.id);
    expect(second.body.data.title).toBe(other!.title);
  });

  it('today rules: editors save, validation, versions; flags are owner/admin only', async () => {
    const cur = await A.get('/v1/admin/config/today', editor);
    expect(cur.body.data).toMatchObject({ key: 'today', value: { emptyRoomThreshold: 10 } });
    const next = { ...cur.body.data.value, emptyRoomThreshold: 25, showDailyMessage: true };
    const ok = await A.put('/v1/admin/config/today', next, editor, { 'if-match': cur.headers.etag as string });
    expect(ok.status).toBe(200);
    expect(ok.body.data.value.emptyRoomThreshold).toBe(25);
    expect(ok.body.data.version).toBe(cur.body.data.version + 1);
    expect((await A.put('/v1/admin/config/today', next, editor, { 'if-match': cur.headers.etag as string })).body.error.code).toBe('CONFLICT_VERSION');
    expect((await A.put('/v1/admin/config/today', { ...next, emptyRoomThreshold: -1 }, editor)).status).toBe(400);
    expect((await A.put('/v1/admin/config/today', { ...next, extra: 1 }, editor)).status).toBe(400);
    expect((await A.put('/v1/admin/config/today', { emptyRoomThreshold: 5 }, editor)).status).toBe(400); // whole object required
    expect((await audit('config.update', 'today'))[0]).toMatchObject({ actor_role: 'editor' });
    expect((await outbox('config:changed'))[0]!.payload).toEqual({ key: 'today', version: ok.body.data.version });
    // the cached value that the app reads is dropped
    const { createRedis, K } = await import('../src/infra/redis');
    const r = createRedis(); expect(await r.get(K.config('today'))).toBeNull(); await r.quit();
    expect((await A.put('/v1/admin/config/main', {}, editor)).status).toBe(403);
  });

  it('settings: all groups readable by owner/admin, validated per key', async () => {
    const all = await A.get('/v1/admin/config', adminTok);
    expect(Object.keys(all.body.data).sort()).toEqual(['breathwork', 'group', 'legal', 'main', 'moderation', 'sos', 'today']);
    expect((await A.get('/v1/admin/config', editor)).status).toBe(403);
    const main = all.body.data.main.value;
    expect((await A.put('/v1/admin/config/main', { ...main, minVersion: { ios: '2', android: '1.0.0' } }, adminTok)).status).toBe(400);
    expect((await A.put('/v1/admin/config/main', { ...main, features: { ...main.features, challenges: true } }, adminTok)).body.data.value.features.challenges).toBe(true);
    expect((await A.put('/v1/admin/config/nope', {}, adminTok)).status).toBe(400);
    expect((await A.put('/v1/admin/config/group', {}, adminTok)).status).toBe(403); // has its own screen
    const mod2 = all.body.data.moderation.value;
    expect((await A.put('/v1/admin/config/moderation', { ...mod2, dailyLimit: 0 }, adminTok)).status).toBe(400);
    expect((await A.put('/v1/admin/config/moderation', { ...mod2, dailyLimit: 5 }, adminTok)).status).toBe(200);
    expect((await A.put('/v1/admin/config/legal', { ...all.body.data.legal.value, privacyUrl: 'ftp://x' }, adminTok)).status).toBe(400);
    // the version gate reads this: raising the minimum makes old apps update
    const g = await guest(app);
    await A.put('/v1/admin/config/main', { ...main, minVersion: { ios: '9.0.0', android: '1.0.0' } }, owner);
    expect((await http(app).get('/v1/me', { token: g.accessToken, headers: { 'x-app-version': '1.0.0' } })).status).toBe(426);
    await A.put('/v1/admin/config/main', main, owner);
    expect((await http(app).get('/v1/me', { token: g.accessToken, headers: { 'x-app-version': '1.0.0' } })).status).toBe(200);
  });

  it('group meditation: time/length validated, history of past days; saving updates the MOTD payload', async () => {
    const g0 = await A.get('/v1/admin/group', editor);
    expect(g0.body.data.value).toEqual({ startUtc: '16:00', lengthMin: 30, lobbyOpenMin: 15, reminderMin: 10 });
    expect(g0.body.data.history.length).toBeGreaterThan(0);
    expect(g0.body.data.history[0]).toMatchObject({ date: expect.any(String), title: expect.any(String), groupJoined: expect.any(Number) });
    expect(g0.body.data.history.every((h: { date: string }) => h.date < dayIso())).toBe(true);
    for (const bad of [{ startUtc: '25:00' }, { lengthMin: 20 }, { lobbyOpenMin: 0 }, { reminderMin: 99 }]) expect((await A.put('/v1/admin/group', { ...g0.body.data.value, ...bad }, editor)).status).toBe(400);
    const user = await guest(app);
    const before = await http(app).get(`/v1/motd/${dayIso(2)}`, { token: user.accessToken }); // caches the payload
    expect(before.body.data.group.startUtc).toBe('16:00');
    const ok = await A.put('/v1/admin/group', { startUtc: '17:15', lengthMin: 45, lobbyOpenMin: 20, reminderMin: 5 }, editor);
    expect(ok.status).toBe(200);
    const after = await http(app).get(`/v1/motd/${dayIso(2)}`, { token: user.accessToken });
    expect(after.body.data.group).toEqual({ startUtc: '17:15', lengthMin: 45 });
  });
});

describe('P3 audit + transactions', () => {
  it('a failed write leaves no audit entry and no event behind', async () => {
    const [a0, o0] = [(await q<{ n: number }>(`SELECT count(*)::int n FROM audit_log`))[0]!.n, (await q<{ n: number }>(`SELECT count(*)::int n FROM outbox_events`))[0]!.n];
    const ids = (await A.get('/v1/admin/themes')).body.data.map((t: { id: string }) => t.id) as string[];
    const [a1, o1] = [(await q<{ n: number }>(`SELECT count(*)::int n FROM audit_log`))[0]!.n, (await q<{ n: number }>(`SELECT count(*)::int n FROM outbox_events`))[0]!.n];
    expect([a1, o1]).toEqual([a0, o0]); // reads write nothing
    expect((await A.put('/v1/admin/themes/order', { ids: ids.slice(1) })).status).toBe(400); // aborts inside the transaction
    const v0 = await catalogVersion();
    expect((await A.del(`/v1/admin/themes/${ids[0]}`)).status).toBe(409);
    expect(await catalogVersion()).toBe(v0);
    const [a2, o2] = [(await q<{ n: number }>(`SELECT count(*)::int n FROM audit_log`))[0]!.n, (await q<{ n: number }>(`SELECT count(*)::int n FROM outbox_events`))[0]!.n];
    expect([a2, o2]).toEqual([a0, o0]);
  });

  it('audit log: filters, cursor, jobs endpoint, owner/admin only', async () => {
    const all = await A.get('/v1/admin/audit?limit=5', adminTok);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(5);
    expect(all.body.meta.nextCursor).toEqual(expect.any(String));
    const next = await A.get(`/v1/admin/audit?limit=5&cursor=${all.body.meta.nextCursor}`, adminTok);
    expect(next.body.data[0].id).toBeLessThan(all.body.data[4].id);
    const themeOnly = await A.get('/v1/admin/audit?targetType=theme&action=theme.create&limit=100');
    expect(themeOnly.body.data.every((e: { action: string; targetType: string }) => e.action === 'theme.create' && e.targetType === 'theme')).toBe(true);
    expect((await A.get('/v1/admin/audit?from=nope')).status).toBe(400);
    expect((await A.get('/v1/admin/audit', editor)).status).toBe(403);
    expect((await A.get('/v1/admin/audit', mod)).status).toBe(403);
    expect((await A.get(`/v1/admin/jobs/${uuid()}`, mod)).status).toBe(404);
    expect((await A.get('/v1/admin/jobs/xyz', mod)).status).toBe(400);
  });
});

describe('P3 list extras used by the CMS screens', () => {
  it('sessions list: total of everything that matches (not just this page) and the SoS filter', async () => {
    const theme = (await A.post('/v1/admin/themes', { name: `Totals ${uuid().slice(-6)}` })).body.data.id;
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await A.post('/v1/admin/sessions', { title: `Total ${i}`, type: 'audio', themeId: theme, durationSec: 300 + i * 60 })).body.data.id);
    await q(`UPDATE sessions SET is_sos=true, sos_order=0 WHERE id=$1`, [made[0]]);

    const page1 = await A.get(`/v1/admin/sessions?theme=${theme}&limit=2`);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.total).toBe(5);
    const page2 = await A.get(`/v1/admin/sessions?theme=${theme}&limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`);
    expect(page2.body.meta.total).toBe(5); // the same on every page

    const sos = await A.get(`/v1/admin/sessions?theme=${theme}&sos=true`);
    expect(sos.body.data.map((s: { id: string }) => s.id)).toEqual([made[0]]);
    expect(sos.body.meta.total).toBe(1);
    expect((await A.get(`/v1/admin/sessions?theme=${theme}&sos=false`)).body.meta.total).toBe(4);
    expect((await A.get(`/v1/admin/sessions?sos=maybe`)).status).toBe(400);

    // themes and teachers carry their counts; archived meditations are not counted
    const t = (await A.get('/v1/admin/themes')).body.data.find((x: { id: string }) => x.id === theme);
    expect(t).toMatchObject({ sessionCount: 5, minDurationSec: 300, maxDurationSec: 540 });
    await q(`UPDATE sessions SET status='archived' WHERE id=$1`, [made[4]]);
    expect((await A.get('/v1/admin/themes')).body.data.find((x: { id: string }) => x.id === theme)).toMatchObject({ sessionCount: 4, maxDurationSec: 480 });
    const empty = (await A.post('/v1/admin/themes', { name: `Empty ${uuid().slice(-6)}` })).body.data.id;
    expect((await A.get('/v1/admin/themes')).body.data.find((x: { id: string }) => x.id === empty)).toMatchObject({ sessionCount: 0, minDurationSec: null, maxDurationSec: null });

    const teacher = (await A.post('/v1/admin/teachers', { name: `Counted ${uuid().slice(-6)}` })).body.data.id;
    await A.patch(`/v1/admin/sessions/${made[1]}`, { teacherId: teacher });
    await A.patch(`/v1/admin/sessions/${made[2]}`, { teacherId: teacher });
    expect((await A.get('/v1/admin/teachers')).body.data.find((x: { id: string }) => x.id === teacher).sessionCount).toBe(2);
  });

  it('programs list: each day carries a short view of its meditation; challenges carry finished counts', async () => {
    const s = (await A.post('/v1/admin/sessions', { title: 'Program day one', type: 'audio', durationSec: 720 })).body.data;
    const p = (await A.post('/v1/admin/programs', { title: `Extras ${uuid().slice(-6)}` })).body.data;
    const withDays = (await A.put(`/v1/admin/programs/${p.id}/days`, { days: [{ day: 1, sessionId: s.id }] })).body.data;
    expect(withDays.days).toEqual([{ day: 1, sessionId: s.id, title: null, session: { id: s.id, title: 'Program day one', durationSec: 720, status: 'draft', type: 'audio', themeId: null } }]);
    expect((await A.get('/v1/admin/programs')).body.data.find((x: { id: string }) => x.id === p.id).days[0].session.title).toBe('Program day one');

    const c = (await A.post('/v1/admin/challenges', { name: `Finished ${uuid().slice(-6)}`, days: 7 })).body.data;
    const g1 = await guest(app), g2 = await guest(app);
    await q(`INSERT INTO challenge_participants (challenge_id, user_id, completed_days, finished_at) VALUES ($1,$2,7,now()), ($1,$3,2,NULL)`, [c.id, g1.me.id, g2.me.id]);
    expect((await A.get('/v1/admin/challenges')).body.data.find((x: { id: string }) => x.id === c.id)).toMatchObject({ participants: 2, finished: 1 });
  });
});
