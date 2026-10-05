import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CdnSigner } from '../src/infra/cdn';
import { createRedis } from '../src/infra/redis';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { bootApp, guest, http, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let free: { accessToken: string; me: { id: string } };
let member: { accessToken: string; me: { id: string } };
const h = () => http(app);
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const dayIso = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  free = await guest(app);
  member = await guest(app);
  await db.query(`INSERT INTO entitlements (user_id, active, product_id, period_type, expires_at) VALUES ($1, true, 'wehum_annual', 'trial', now() + interval '7 days')`, [member.me.id]);
});
afterAll(async () => { await db?.end(); await app?.close(); });

const premiumSession = async () => (await q<{ id: string }>(`SELECT id FROM sessions WHERE access='premium' AND status='live' AND NOT is_sos AND type='audio' ORDER BY slug LIMIT 1`))[0]!.id;
const freeSession = async () => (await q<{ id: string }>(`SELECT id FROM sessions WHERE access='free' AND type='youtube' ORDER BY slug LIMIT 1`))[0]!.id;

describe('P2 catalog snapshot', () => {
  it('returns the snapshot with ETag + CDN cache headers', async () => {
    const r = await h().get('/v1/catalog', { token: free.accessToken });
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"c1"');
    expect(r.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=600');
    expect(r.body.meta.version).toBe(1);
    const c = r.body.data;
    expect(c.themes).toHaveLength(8);
    expect(c.teachers).toHaveLength(1);
    expect(c.sessions.length).toBe(28); // 24 premium + 4 free, SoS excluded
    expect(c.programs[0].days).toHaveLength(7);
    expect(c.soundBlocks).toHaveLength(13);
    expect(c.sos.tiles).toHaveLength(8);
    expect(c.sos.tiles[0]).toMatchObject({ feeling: 'Panic' });
    expect(c.sessions.some((s: { isSos?: boolean }) => s.isSos)).toBe(false);
  });

  it('never leaks storage keys, media ids or premium youtube ids', async () => {
    const r = await h().get('/v1/catalog', { token: free.accessToken });
    const raw = JSON.stringify(r.body);
    expect(raw).not.toMatch(/seed\/audio|storageKey|mediaId|hlsKey/);
    for (const s of r.body.data.sessions) {
      if (s.access === 'premium') expect(s.youtubeId).toBeNull();
      else expect(s.youtubeId).toEqual(expect.any(String));
    }
    expect(r.body.data.sessions[0].cover.url).toMatch(/^http:\/\/localhost:9000\/wehum-media-dev\/img\//);
  });

  it('304 via If-None-Match and via ?version=, 200 after the version is bumped', async () => {
    const etag = '"c1"';
    const a = await h().get('/v1/catalog', { token: free.accessToken, headers: { 'if-none-match': etag } });
    expect(a.status).toBe(304);
    expect(a.body).toBe('');
    const b = await h().get('/v1/catalog?version=1', { token: free.accessToken });
    expect(b.status).toBe(304);
    const c = await h().get('/v1/catalog?version=0', { token: free.accessToken });
    expect(c.status).toBe(200);

    await q(`UPDATE sessions SET title = 'Renamed for test' WHERE id = $1`, [await premiumSession()]);
    const v = await app.get(CatalogService).bump();
    expect(v).toBe(2);
    const d = await h().get('/v1/catalog', { token: free.accessToken, headers: { 'if-none-match': etag } });
    expect(d.status).toBe(200);
    expect(d.headers.etag).toBe('"c2"');
    expect(d.body.data.sessions.some((s: { title: string }) => s.title === 'Renamed for test')).toBe(true);
    expect((await h().get('/v1/catalog?version=2', { token: free.accessToken })).status).toBe(304);
  });

  it('requires a token', async () => {
    expect((await h().get('/v1/catalog')).body.error.code).toBe('AUTH_REQUIRED');
  });

  it('hides draft, archived and not-yet-published sessions', async () => {
    const base = { type: 'audio', theme: null };
    for (const [slug, status, publishAt] of [['t-draft', 'draft', null], ['t-archived', 'archived', null], ['t-future', 'live', new Date(Date.now() + 86_400_000)], ['t-visible', 'live', new Date(Date.now() - 1000)]] as const) {
      await db.query(`INSERT INTO sessions (id, slug, title, type, access, duration_sec, status, publish_at) VALUES ($1,$2,$2,$3,'premium',600,$4,$5)`, [uuid(), slug, base.type, status, publishAt]);
    }
    await app.get(CatalogService).bump();
    const r = await h().get('/v1/catalog', { token: free.accessToken });
    const slugs = r.body.data.sessions.map((s: { slug: string }) => s.slug);
    expect(slugs).toContain('t-visible');
    expect(slugs).not.toContain('t-draft');
    expect(slugs).not.toContain('t-archived');
    expect(slugs).not.toContain('t-future');
    const id = (await q<{ id: string }>(`SELECT id FROM sessions WHERE slug='t-draft'`))[0]!.id;
    expect((await h().get(`/v1/sessions/${id}`, { token: free.accessToken })).status).toBe(404);
  });
});

describe('P2 details', () => {
  it('session detail: theme, teacher, practicedToday, no media internals', async () => {
    const id = await premiumSession();
    const r = await h().get(`/v1/sessions/${id}`, { token: free.accessToken });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, max-age=0');
    expect(r.body.data).toMatchObject({ id, access: 'premium', youtubeId: null, teacher: { name: 'Raphael Reiter' }, dedications: { preview: [] } });
    expect(r.body.data.theme.name).toEqual(expect.any(String));
    expect(r.body.data.practicedToday).toEqual(expect.any(Number));
    expect(JSON.stringify(r.body)).not.toMatch(/mediaId|storageKey/);
  });

  it('validates ids and 404s unknown ones', async () => {
    expect((await h().get('/v1/sessions/not-a-uuid', { token: free.accessToken })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await h().get(`/v1/sessions/${uuid()}`, { token: free.accessToken })).body.error.code).toBe('NOT_FOUND');
    expect((await h().get(`/v1/programs/${uuid()}`, { token: free.accessToken })).status).toBe(404);
    expect((await h().get(`/v1/teachers/${uuid()}`, { token: free.accessToken })).status).toBe(404);
  });

  it('program detail carries my progress (null until started)', async () => {
    const p = (await q<{ id: string }>(`SELECT id FROM programs LIMIT 1`))[0]!.id;
    const a = await h().get(`/v1/programs/${p}`, { token: free.accessToken });
    expect(a.status).toBe(200);
    expect(a.body.data.days).toHaveLength(7);
    expect(a.body.data.days[0].session.id).toEqual(expect.any(String));
    expect(a.body.data.progress).toBeNull();
    await q(`INSERT INTO program_progress (user_id, program_id, current_day, completed_days) VALUES ($1,$2,3,'{1,2}')`, [member.me.id, p]);
    const b = await h().get(`/v1/programs/${p}`, { token: member.accessToken });
    expect(b.body.data.progress).toMatchObject({ currentDay: 3, completedDays: [1, 2], completedAt: null });
    expect((await h().get(`/v1/programs/${p}`, { token: free.accessToken })).body.data.progress).toBeNull();
  });

  it('teacher detail lists live sessions only', async () => {
    const t = (await q<{ id: string }>(`SELECT id FROM teachers LIMIT 1`))[0]!.id;
    const r = await h().get(`/v1/teachers/${t}`, { token: free.accessToken });
    expect(r.body.data).toMatchObject({ name: 'Raphael Reiter' });
    expect(r.body.data.sessions.length).toBeGreaterThan(20);
    expect(r.body.data.sessions.map((s: { slug: string }) => s.slug)).not.toContain('t-draft');
  });

  it('SoS: tiles in order, ETag → 304', async () => {
    const a = await h().get('/v1/sos', { token: free.accessToken });
    expect(a.status).toBe(200);
    expect(a.body.data.title).toBe('How can I help?');
    expect(a.body.data.tiles.map((t: { feeling: string }) => t.feeling).slice(0, 3)).toEqual(['Panic', 'Anxiety', 'Can’t stop thinking']);
    expect(a.body.data.help.contactEmail).toBe('hello@wehum.app');
    const b = await h().get('/v1/sos', { token: free.accessToken, headers: { 'if-none-match': a.headers.etag as string } });
    expect(b.status).toBe(304);
  });
});

describe('P2 search', () => {
  it('finds by title, theme tag and filters', async () => {
    const a = await h().get('/v1/search?q=breath', { token: free.accessToken });
    expect(a.status).toBe(200);
    expect(a.body.data.length).toBeGreaterThan(0);
    expect(a.body.data[0].title.toLowerCase()).toContain('breath');
    const tag = await h().get('/v1/search?q=sleep', { token: free.accessToken });
    expect(tag.body.data.length).toBeGreaterThan(0);
    const yt = await h().get('/v1/search?type=youtube', { token: free.accessToken });
    expect(yt.body.data).toHaveLength(4);
    expect(yt.body.data.every((s: { access: string }) => s.access === 'free')).toBe(true);
    expect((await h().get('/v1/search?access=free&limit=2', { token: free.accessToken })).body.data).toHaveLength(2);
    expect((await h().get('/v1/search?q=zzzzzqx', { token: free.accessToken })).body.data).toEqual([]);
  });

  it('validates input and treats LIKE wildcards literally', async () => {
    expect((await h().get('/v1/search?q=a', { token: free.accessToken })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await h().get('/v1/search?limit=500', { token: free.accessToken })).status).toBe(400);
    expect((await h().get('/v1/search?q=%25%25', { token: free.accessToken })).body.data).toEqual([]);
    expect((await h().get('/v1/search?q=_____', { token: free.accessToken })).body.data).toEqual([]);
    expect((await h().get(`/v1/search?q=${encodeURIComponent("'; DROP TABLE sessions;--")}`, { token: free.accessToken })).body.data).toEqual([]);
  });
});

describe('P2 MOTD + daily messages', () => {
  it('MOTD for today: three lengths, premium access, no media internals', async () => {
    const r = await h().get(`/v1/motd/${dayIso()}`, { token: free.accessToken });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ date: dayIso(), lengths: [10, 30, 45], access: 'premium', group: { startUtc: '16:00', lengthMin: 30 } });
    expect(r.body.data.title).toEqual(expect.any(String));
    expect(JSON.stringify(r.body)).not.toMatch(/mediaId|storageKey/);
  });

  it('MOTD: past without a day → 404, bad date → 400, far future is clamped to tomorrow', async () => {
    expect((await h().get('/v1/motd/2020-01-01', { token: free.accessToken })).body.error.code).toBe('NOT_FOUND');
    expect((await h().get('/v1/motd/2026-13-45', { token: free.accessToken })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await h().get('/v1/motd/today', { token: free.accessToken })).status).toBe(400);
    const far = await h().get(`/v1/motd/${dayIso(9)}`, { token: free.accessToken });
    expect(far.body.data.date).toBe(dayIso(1));
  });

  it('practicedToday reflects the live Redis counter', async () => {
    const { K } = await import('../src/infra/redis');
    const r = createRedis();
    const today = dayIso();
    await r.del(`motd:${today}`);
    await r.sadd(K.practiced(today), ...Array.from({ length: 1500 }, (_, i) => `u${i}`));
    const out = await h().get(`/v1/motd/${today}`, { token: free.accessToken });
    expect(out.body.data.practicedToday).toBe(1500);
    await r.del(K.practiced(today)); await r.quit();
  });

  it('daily messages are member-only', async () => {
    expect((await h().get(`/v1/daily-messages/${dayIso()}`, { token: free.accessToken })).body.error.code).toBe('PREMIUM_REQUIRED');
    expect((await h().get('/v1/daily-messages', { token: free.accessToken })).status).toBe(403);
    expect((await h().get('/v1/daily-messages')).status).toBe(401);
  });

  it('member: message for today, falls back to the latest earlier one, never serves the future', async () => {
    await q(`INSERT INTO daily_messages (date, type, title, text, status) VALUES ($1,'text','From the future','x','live')`, [dayIso(5)]);
    const today = await h().get(`/v1/daily-messages/${dayIso()}`, { token: member.accessToken });
    expect(today.status).toBe(200);
    expect(today.body.data).toMatchObject({ date: dayIso(), type: expect.any(String) });
    const gap = await h().get(`/v1/daily-messages/${dayIso(-30)}`, { token: member.accessToken });
    expect(gap.body.error.code).toBe('NOT_FOUND'); // nothing earlier than 30 days ago
    const far = await h().get(`/v1/daily-messages/${dayIso(5)}`, { token: member.accessToken });
    expect(far.body.data.title).not.toBe('From the future');
  });

  it('archive: keyset pagination, newest first, theme filter', async () => {
    const a = await h().get('/v1/daily-messages?limit=3', { token: member.accessToken });
    expect(a.body.data).toHaveLength(3);
    const dates = a.body.data.map((m: { date: string }) => m.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(a.body.meta.nextCursor).toEqual(expect.any(String));
    const b = await h().get(`/v1/daily-messages?limit=3&cursor=${a.body.meta.nextCursor}`, { token: member.accessToken });
    expect(b.body.data[0].date < dates[2]).toBe(true);
    const all = await h().get('/v1/daily-messages?limit=100', { token: member.accessToken });
    expect(all.body.meta.nextCursor).toBeNull();
    expect(all.body.data.map((m: { title: string }) => m.title)).not.toContain('From the future');
    const t = await h().get('/v1/daily-messages?theme=Mindfulness', { token: member.accessToken });
    expect(t.body.data.every((m: { themeTag: string }) => m.themeTag === 'Mindfulness')).toBe(true);
  });
});

describe('P2 play-url (signed, premium-gated)', () => {
  const play = (token: string, body: unknown) => h().post('/v1/media/play-url', body, { token });

  it('premium session: free → 403 PREMIUM_REQUIRED, member → signed URL valid 6 h', async () => {
    const id = await premiumSession();
    const denied = await play(free.accessToken, { kind: 'session', id });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PREMIUM_REQUIRED');

    const ok = await play(member.accessToken, { kind: 'session', id });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    const d = ok.body.data;
    expect(d).toMatchObject({ type: 'audio', mime: 'audio/mp4', youtubeId: null });
    const u = new URL(d.url);
    const exp = Number(u.searchParams.get('exp'));
    expect(u.pathname).toMatch(/^\/wehum-media-dev\/seed\/audio\//);
    expect(exp - Date.now() / 1000).toBeGreaterThan(6 * 3600 - 30);
    expect(exp - Date.now() / 1000).toBeLessThan(6 * 3600 + 30);
    expect(new Date(d.expiresAt).getTime() / 1000).toBe(exp);
    const key = u.pathname.replace('/wehum-media-dev/', '');
    expect(u.searchParams.get('sig')).toBe(app.get(CdnSigner).signature(key, exp));
    expect(u.searchParams.get('sig')).not.toBe(app.get(CdnSigner).signature(key, exp + 1)); // signature binds the expiry
  });

  it('downloads get a 7-day URL; non-downloadable sessions are refused', async () => {
    const id = await premiumSession();
    const r = await play(member.accessToken, { kind: 'session', id, download: true });
    const exp = Number(new URL(r.body.data.url).searchParams.get('exp'));
    expect(exp - Date.now() / 1000).toBeGreaterThan(7 * 86400 - 30);
    await q(`UPDATE sessions SET downloadable=false WHERE id=$1`, [id]);
    expect((await play(member.accessToken, { kind: 'session', id, download: true })).body.error.code).toBe('INVALID_STATE');
    expect((await play(member.accessToken, { kind: 'session', id })).status).toBe(200);
  });

  it('free library item plays for everyone as a YouTube id (no URL, no download)', async () => {
    const id = await freeSession();
    const r = await play(free.accessToken, { kind: 'session', id });
    expect(r.body.data).toMatchObject({ type: 'youtube', url: null, youtubeId: expect.stringMatching(/^seedYT/) });
    expect((await play(free.accessToken, { kind: 'session', id, download: true })).body.error.code).toBe('INVALID_STATE');
  });

  it('MOTD audio is premium; picks the requested length', async () => {
    const body = { kind: 'motd', date: dayIso(), lengthMin: 30 };
    expect((await play(free.accessToken, body)).body.error.code).toBe('PREMIUM_REQUIRED');
    const ok = await play(member.accessToken, body);
    expect(ok.status).toBe(200);
    expect(ok.body.data.durationSec).toBe(1800);
    expect((await play(member.accessToken, { kind: 'motd', date: '2020-01-01', lengthMin: 30 })).status).toBe(404);
    expect((await play(member.accessToken, { kind: 'motd', date: dayIso(), lengthMin: 20 })).status).toBe(400);
  });

  it('sound block + daily message audio', async () => {
    const b = (await q<{ id: string }>(`SELECT id FROM sound_blocks ORDER BY "order" LIMIT 1`))[0]!.id;
    expect((await play(free.accessToken, { kind: 'block', id: b })).status).toBe(403);
    expect((await play(member.accessToken, { kind: 'block', id: b })).body.data.type).toBe('audio');
    const media = (await q<{ id: string }>(`SELECT id FROM media_assets WHERE kind='audio' LIMIT 1`))[0]!.id;
    await q(`UPDATE daily_messages SET media_id=$1, type='audio' WHERE date=$2`, [media, dayIso()]);
    expect((await play(free.accessToken, { kind: 'daily_message', date: dayIso() })).status).toBe(403);
    expect((await play(member.accessToken, { kind: 'daily_message', date: dayIso() })).status).toBe(200);
    expect((await play(member.accessToken, { kind: 'daily_message', date: dayIso(-5) })).body.error.code).toBe('NOT_FOUND'); // text-only message
  });

  it('media that is not ready → 422 MEDIA_NOT_READY', async () => {
    const id = await premiumSession();
    const media_id = (await q<{ media_id: string }>(`SELECT media_id FROM sessions WHERE id=$1`, [id]))[0]!.media_id;
    await q(`UPDATE media_assets SET status='processing' WHERE id=$1`, [media_id]);
    const r = await play(member.accessToken, { kind: 'session', id });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('MEDIA_NOT_READY');
    await q(`UPDATE media_assets SET status='ready' WHERE id=$1`, [media_id]);
  });

  it('validates the body, requires a token, ignores unknown ids', async () => {
    expect((await play(member.accessToken, { kind: 'nope' })).status).toBe(400);
    expect((await play(member.accessToken, { kind: 'session', id: 'x' })).status).toBe(400);
    expect((await play(member.accessToken, { kind: 'session', id: uuid(), extra: 1 })).status).toBe(400);
    expect((await play(member.accessToken, { kind: 'session', id: uuid() })).body.error.code).toBe('NOT_FOUND');
    expect((await h().post('/v1/media/play-url', { kind: 'session', id: uuid() })).status).toBe(401);
  });

  it('entitlement changes take effect once the 60 s cache is busted', async () => {
    const u = await guest(app);
    const id = await premiumSession();
    expect((await play(u.accessToken, { kind: 'session', id })).status).toBe(403);
    await q(`INSERT INTO entitlements (user_id, active, expires_at) VALUES ($1, true, now() + interval '1 day')`, [u.me.id]);
    expect((await play(u.accessToken, { kind: 'session', id })).status).toBe(403); // cached "no"
    await app.get(EntitlementService).invalidate(u.me.id);
    expect((await play(u.accessToken, { kind: 'session', id })).status).toBe(200);
    await q(`UPDATE entitlements SET expires_at = now() - interval '1 minute' WHERE user_id=$1`, [u.me.id]);
    await app.get(EntitlementService).invalidate(u.me.id);
    expect((await play(u.accessToken, { kind: 'session', id })).body.error.code).toBe('PREMIUM_REQUIRED'); // expired entitlement
  });
});

describe('P2 performance (in-process, excluding network)', () => {
  const pctl = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
  async function measure(n: number, fn: () => Promise<{ status: number }>, ok: number[]) {
    const clearRates = async () => { const r = createRedis(); const ks = await r.keys('rl:*'); if (ks.length) await r.del(...ks); await r.quit(); };
    await clearRates();
    for (let i = 0; i < 20; i++) await fn(); // warm
    const t: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i % 25 === 24) await clearRates(); // stay under the 120/min limit; this test measures handler latency
      const s = process.hrtime.bigint();
      const r = await fn();
      t.push(Number(process.hrtime.bigint() - s) / 1e6);
      expect(ok).toContain(r.status);
    }
    return { p50: pctl(t, 0.5), p95: pctl(t, 0.95), p99: pctl(t, 0.99) };
  }

  it('cached reads meet the budget (p50 < 15 ms, p95 < 50 ms)', async () => {
    const t = member.accessToken;
    const id = await premiumSession();
    const etag = (await h().get('/v1/catalog', { token: t })).headers.etag as string;
    const results: Record<string, { p50: number; p95: number; p99: number }> = {};
    results['catalog 200'] = await measure(150, () => h().get('/v1/catalog', { token: t }), [200]);
    results['catalog 304'] = await measure(150, () => h().get('/v1/catalog', { token: t, headers: { 'if-none-match': etag } }), [304]);
    results['sos'] = await measure(150, () => h().get('/v1/sos', { token: t }), [200]);
    results['motd'] = await measure(150, () => h().get(`/v1/motd/${dayIso()}`, { token: t }), [200]);
    results['session'] = await measure(150, () => h().get(`/v1/sessions/${id}`, { token: t }), [200]);
    console.log('P2 latency (ms)', JSON.stringify(results));
    for (const [name, r] of Object.entries(results)) {
      expect(r.p50, `${name} p50`).toBeLessThan(15);
      expect(r.p95, `${name} p95`).toBeLessThan(50);
    }
  });

  it('uncached reads meet the budget (p95 < 120 ms)', async () => {
    const t = free.accessToken;
    const r = await measure(100, () => h().get('/v1/search?q=breath', { token: t }), [200]);
    console.log('P2 search latency (ms)', JSON.stringify(r));
    expect(r.p95).toBeLessThan(120);
  });
});
