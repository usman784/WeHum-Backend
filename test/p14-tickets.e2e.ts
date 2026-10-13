import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { YoutubeService } from '../src/modules/admin/content/youtube';
import { SocialVerifier } from '../src/modules/auth/social.verifier';
import { NewsletterService } from '../src/modules/newsletter/newsletter.service';
import { adminToken, bootApp, clearRates, guest, http, makeAdmin, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let signGoogle: (c: Record<string, unknown>) => Promise<string>;
const h = () => http(app);
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'g-k', alg: 'RS256', use: 'sig' };
  app.get(SocialVerifier).useKeys('google', createLocalJWKSet({ keys: [jwk] }));
  signGoogle = (c) => new SignJWT(c).setProtectedHeader({ alg: 'RS256', kid: 'g-k' }).setIssuer('https://accounts.google.com').setAudience('test-google-client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
});
beforeEach(async () => { await clearRates(); });
afterAll(async () => { await db?.end(); await app?.close(); });

const google = (sub: string, email: string) => signGoogle({ sub, email, email_verified: true, name: 'Gina Google', picture: 'https://lh3.example/p.jpg' });

describe('profile bio', () => {
  it('is saved, shown, limited to 200 characters and can be cleared', async () => {
    const g = await guest(app);
    const r = await h().patch('/v1/me', { bio: '  Sitting every morning.  ' }, { token: g.accessToken });
    expect(r.status).toBe(200);
    expect(r.body.data.bio).toBe('Sitting every morning.');
    expect((await h().patch('/v1/me', { bio: 'x'.repeat(201) }, { token: g.accessToken })).status).toBe(400);
    expect((await h().patch('/v1/me', { bio: 'x'.repeat(200) }, { token: g.accessToken })).body.data.bio).toHaveLength(200);
    expect((await h().patch('/v1/me', { bio: '' }, { token: g.accessToken })).body.data.bio).toBeNull();
  });
});

describe('one e-mail, one account', () => {
  it('Google with an address that already has an e-mail account: told to log in with e-mail', async () => {
    const a = await guest(app);
    await h().post('/v1/auth/link/email', { email: 'both@x.test', password: 'Sup3r-secret-pw', firstName: 'Bo' }, { token: a.accessToken });
    const b = await guest(app);
    const r = await h().post('/v1/auth/google', { idToken: await google('g-both', 'both@x.test') }, { token: b.accessToken });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EMAIL_REGISTERED');
    expect(r.body.error.message).toContain('email and password');
    expect(r.body.error.details.methods).toEqual(['email']);
    expect(await q(`SELECT 1 FROM auth_identities WHERE provider='google' AND provider_uid='g-both'`)).toHaveLength(0); // nothing was created
  });

  it('e-mail sign-up and e-mail login for an address that only signs in with Google: told to use Google', async () => {
    const a = await guest(app);
    expect((await h().post('/v1/auth/google', { idToken: await google('g-only', 'gonly@x.test') }, { token: a.accessToken })).status).toBe(200);
    const b = await guest(app);
    const up = await h().post('/v1/auth/link/email', { email: 'gonly@x.test', password: 'Sup3r-secret-pw' }, { token: b.accessToken });
    expect(up.status).toBe(409);
    expect(up.body.error).toMatchObject({ code: 'EMAIL_REGISTERED' });
    expect(up.body.error.message).toContain('Google');
    const login = await h().post('/v1/auth/email/login', { email: 'gonly@x.test', password: 'whatever-123' }, {});
    expect(login.status).toBe(409);
    expect(login.body.error.code).toBe('EMAIL_REGISTERED');
    expect((await h().post('/v1/auth/email/login', { email: 'nobody@x.test', password: 'whatever-123' }, {})).body.error.code).toBe('INVALID_CREDENTIALS'); // unknown address: unchanged
  });

  it('signing in again with the same Google account still works', async () => {
    const a = await guest(app);
    await h().post('/v1/auth/google', { idToken: await google('g-again', 'again@x.test') }, { token: a.accessToken });
    const b = await guest(app);
    expect((await h().post('/v1/auth/google', { idToken: await google('g-again', 'again@x.test') }, { token: b.accessToken })).status).toBe(200);
  });
});

describe('newsletter list (Mailchimp, from the server)', () => {
  const calls: { url: string; method: string; body: Record<string, unknown>; auth: string }[] = [];
  let respond: () => Response = () => new Response('{}', { status: 200 });
  beforeAll(() => {
    (env as { MAILCHIMP_API_KEY: string }).MAILCHIMP_API_KEY = 'abcdef0123456789-us21';
    NewsletterService.fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method), body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) });
      return respond();
    }) as typeof fetch;
  });

  const verifiedPerson = async (email: string, first: string) => {
    const g = await guest(app);
    await h().post('/v1/auth/link/email', { email, password: 'Sup3r-secret-pw', firstName: first }, { token: g.accessToken });
    await q(`UPDATE users SET email_verified_at = now() WHERE email = $1`, [email]);
  };
  const turnOn = (over: Record<string, unknown> = {}) => q(`INSERT INTO app_config (key, value, version) VALUES ('newsletter', $1, 1) ON CONFLICT (key) DO UPDATE SET value = $1, version = app_config.version + 1`, [JSON.stringify({ enabled: true, listId: 'list123', doubleOptIn: true, tags: ['wehum-app'], ...over })]);
  const refresh = async () => { const { K } = await import('../src/infra/redis'); const Redis = (await import('ioredis')).default; const r = new Redis(process.env.REDIS_URL!); await r.del(K.config('newsletter')); await r.quit(); };

  it('does nothing while it is off or the key is missing', async () => {
    await verifiedPerson('nl0@x.test', 'Nina');
    expect(await app.get(NewsletterService).syncPending()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('adds each verified address once, with the name, tags and double opt-in, to the right list', async () => {
    await turnOn(); await refresh();
    await verifiedPerson('nl1@x.test', 'Noor');
    await q(`INSERT INTO users (id, is_guest, email, email_verified_at) VALUES (gen_random_uuid(), true, 'guest@x.test', now())`); // a guest is never added
    const svc = app.get(NewsletterService);
    expect(await svc.syncPending()).toBeGreaterThanOrEqual(2); // everyone verified so far, nl0 (signed up before it was on) included
    expect(calls.map((c) => c.body.email_address)).toEqual(expect.arrayContaining(['nl0@x.test', 'nl1@x.test']));
    const mine = calls.find((c) => c.body.email_address === 'nl1@x.test')!;
    expect(mine.method).toBe('PUT');
    expect(mine.url).toBe(`https://us21.api.mailchimp.com/3.0/lists/list123/members/${createHash('md5').update('nl1@x.test').digest('hex')}`);
    expect(mine.body).toMatchObject({ status_if_new: 'pending', tags: ['wehum-app'], merge_fields: { FNAME: 'Noor' } });
    expect(mine.auth).toBe(`Basic ${Buffer.from('wehum:abcdef0123456789-us21').toString('base64')}`);
    expect(calls.some((c) => c.body.email_address === 'guest@x.test')).toBe(false);
    calls.length = 0;
    expect(await svc.syncPending()).toBe(0); // once each
    expect(calls).toHaveLength(0);
  });

  it('a refused address is marked and not retried; an outage leaves everyone for the next minute', async () => {
    await verifiedPerson('nl2@x.test', 'Bad');
    respond = () => new Response(JSON.stringify({ title: 'Forgotten Email Not Subscribed', detail: 'removed on purpose' }), { status: 400 });
    const svc = app.get(NewsletterService);
    expect(await svc.syncPending()).toBe(0);
    expect((await q(`SELECT newsletter_error FROM users WHERE email='nl2@x.test'`))[0]!.newsletter_error).toContain('Forgotten Email');
    await verifiedPerson('nl3@x.test', 'Later');
    respond = () => new Response('{}', { status: 503 });
    expect(await svc.syncPending()).toBe(0);
    expect((await q(`SELECT newsletter_synced_at FROM users WHERE email='nl3@x.test'`))[0]!.newsletter_synced_at).toBeNull();
    respond = () => new Response('{}', { status: 200 });
    expect(await svc.syncPending()).toBe(1);
  });

  it('the CMS sees the numbers; editors cannot', async () => {
    const owner = await adminToken(app, await makeAdmin(db, 'owner'));
    const st = await h().get('/v1/admin/newsletter/status', { token: owner });
    expect(st.body.data).toMatchObject({ enabled: true, keyConfigured: true, listId: 'list123', failed: 1 });
    expect(st.body.data.synced).toBeGreaterThanOrEqual(3);
    const editor = await adminToken(app, await makeAdmin(db, 'editor'));
    expect((await h().get('/v1/admin/newsletter/status', { token: editor })).status).toBe(403);
    const cfg = await h().get('/v1/admin/config', { token: owner });
    expect(cfg.body.data.newsletter.value).toMatchObject({ enabled: true, listId: 'list123' });
  });
});

describe('YouTube description', () => {
  const page = (desc: string) => `<html>..."videoDetails":{"shortDescription":${JSON.stringify(desc)},"isCrawlable":true}...</html>`;

  it('is read from the watch page, with its links and line breaks, capped', async () => {
    const real = YoutubeService.fetchImpl;
    YoutubeService.fetchImpl = (async () => new Response(page('Free daily message:\r\nhttps://www.raphaelreiter.com\n\n\n\nMore at https://youtu.be/abc'), { status: 200 })) as typeof fetch;
    try {
      const d = await app.get(YoutubeService).describe('bp-2_tAO3NY');
      expect(d).toBe('Free daily message:\nhttps://www.raphaelreiter.com\n\nMore at https://youtu.be/abc');
      YoutubeService.fetchImpl = (async () => new Response(page('x'.repeat(9000)), { status: 200 })) as typeof fetch;
      expect((await app.get(YoutubeService).describe('bp-2_tAO3NY'))!.length).toBe(4000);
      YoutubeService.fetchImpl = (async () => new Response('nothing here', { status: 200 })) as typeof fetch;
      expect(await app.get(YoutubeService).describe('bp-2_tAO3NY')).toBeNull(); // a missing description never fails anything
    } finally { YoutubeService.fetchImpl = real; }
  });

  it('is filled into the YouTube items that have none, and the catalog version moves', async () => {
    const real = YoutubeService.fetchImpl;
    YoutubeService.fetchImpl = (async () => new Response(page('From the channel'), { status: 200 })) as typeof fetch;
    try {
      await q(`INSERT INTO sessions (id, slug, title, type, access, duration_sec, youtube_id, status) VALUES (gen_random_uuid(), 'yt-one', 'Yt one', 'youtube', 'free', 600, 'bp-2_tAO3NY', 'live')`);
      const owner = await adminToken(app, await makeAdmin(db, 'owner'));
      const before = (await q(`SELECT version FROM app_config WHERE key='catalog'`))[0]?.version ?? 0;
      const r = await h().post('/v1/admin/youtube/descriptions', {}, { token: owner });
      expect(r.body.data.filled).toBe(r.body.data.checked);
      expect(r.body.data.checked).toBeGreaterThanOrEqual(1); // the seeded YouTube items too
      expect((await q(`SELECT description FROM sessions WHERE slug='yt-one'`))[0]!.description).toBe('From the channel');
      expect((await q(`SELECT version FROM app_config WHERE key='catalog'`))[0]!.version).toBeGreaterThan(before);
      expect((await h().post('/v1/admin/youtube/descriptions', {}, { token: owner })).body.data).toEqual({ checked: 0, filled: 0 }); // nothing missing any more
    } finally { YoutubeService.fetchImpl = real; }
  });
});
