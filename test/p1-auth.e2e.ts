import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../src/infra/mailer';
import { SocialVerifier } from '../src/modules/auth/social.verifier';
import { sha256, TokensService } from '../src/modules/auth/tokens.service';
import { bootApp, guest, http, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
const keys: Record<string, { sign: (claims: Record<string, unknown>) => Promise<string> }> = {};

async function fakeProvider(provider: 'apple' | 'google') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: `${provider}-k`, alg: 'RS256', use: 'sig' };
  app.get(SocialVerifier).useKeys(provider, createLocalJWKSet({ keys: [jwk] }));
  const iss = provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com';
  const aud = provider === 'apple' ? 'app.wehum.meditation' : 'test-google-client';
  keys[provider] = { sign: (c) => new SignJWT(c).setProtectedHeader({ alg: 'RS256', kid: `${provider}-k` }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(privateKey) };
}
const lastMailToken = () => Mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1]!;

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  await fakeProvider('apple'); await fakeProvider('google');
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
afterAll(async () => { await db?.end(); await app?.close(); });

describe('P1 guest session', () => {
  it('creates a guest and is idempotent per install id', async () => {
    const a = await guest(app, 'install-aaaaaaaa');
    const b = await guest(app, 'install-aaaaaaaa');
    expect(a.me.isGuest).toBe(true);
    expect(b.me.id).toBe(a.me.id);
    expect(a.refreshToken).not.toBe(b.refreshToken);
  });

  it('validates input', async () => {
    const r = await http(app).post('/v1/auth/guest', { installId: 'x', platform: 'web' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(r.body.error.details.fields.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['installId', 'platform']));
  });

  it('GET/PATCH /v1/me requires a token and validates', async () => {
    expect((await http(app).get('/v1/me')).body.error.code).toBe('AUTH_REQUIRED');
    const g = await guest(app);
    const ok = await http(app).patch('/v1/me', { firstName: 'Marcus', reminderTime: '06:30', theme: 'light' }, { token: g.accessToken });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ firstName: 'Marcus', reminder: { enabled: true, time: '06:30' }, theme: 'light' });
    const bad = await http(app).patch('/v1/me', { timezone: 'Mars/Olympus', reminderTime: '25:00' }, { token: g.accessToken });
    expect(bad.status).toBe(400);
    const unknown = await http(app).patch('/v1/me', { isGuest: false }, { token: g.accessToken });
    expect(unknown.status).toBe(400);
  });
});

describe('P1 refresh rotation', () => {
  it('rotates and detects reuse (whole family revoked)', async () => {
    const g = await guest(app);
    const r1 = await http(app).post('/v1/auth/refresh', { refreshToken: g.refreshToken });
    expect(r1.status).toBe(200);
    const next = r1.body.data.refreshToken as string;
    const reuse = await http(app).post('/v1/auth/refresh', { refreshToken: g.refreshToken });
    expect(reuse.body.error.code).toBe('TOKEN_REUSED');
    const after = await http(app).post('/v1/auth/refresh', { refreshToken: next });
    expect(after.body.error.code).toBe('TOKEN_INVALID');
  });

  it('expired access token → TOKEN_EXPIRED', async () => {
    const g = await guest(app);
    const t = await app.get(TokensService).signAccess({ sub: g.me.id, gst: true, prm: false, ver: 0 }, 'wehum-app', 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await http(app).get('/v1/me', { token: t })).body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('logout revokes the refresh family', async () => {
    const g = await guest(app);
    expect((await http(app).post('/v1/auth/logout', { refreshToken: g.refreshToken }, { token: g.accessToken })).status).toBe(204);
    expect((await http(app).post('/v1/auth/refresh', { refreshToken: g.refreshToken })).body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('P1 email accounts', () => {
  it('link email → account, verify mail, login from another device, lockout', async () => {
    const g = await guest(app);
    Mailer.outbox = [];
    const l = await http(app).post('/v1/auth/link/email', { email: 'Marcus@Example.com', password: 'calm-river-77', firstName: 'Marcus' }, { token: g.accessToken });
    expect(l.status).toBe(200);
    expect(l.body.data.me).toMatchObject({ id: g.me.id, isGuest: false, email: 'marcus@example.com', providers: ['email'], firstName: 'Marcus' });
    expect(Mailer.outbox[0]!.subject).toMatch(/Confirm your email/);
    expect((await http(app).post('/v1/auth/email/verify', { token: lastMailToken() })).status).toBe(200);

    const login = await http(app).post('/v1/auth/email/login', { email: 'marcus@example.com', password: 'calm-river-77' }, { headers: { 'x-install-id': 'other-device-1', 'x-forwarded-for': '9.9.9.9' } });
    expect(login.status).toBe(200);
    expect(login.body.data.me.id).toBe(g.me.id);

    for (let i = 0; i < 5; i++) {
      const w = await http(app).post('/v1/auth/email/login', { email: 'marcus@example.com', password: 'wrong-pass' }, { headers: { 'x-forwarded-for': '8.8.8.8' } });
      expect(w.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await http(app).post('/v1/auth/email/login', { email: 'marcus@example.com', password: 'calm-river-77' }, { headers: { 'x-forwarded-for': '8.8.8.8' } });
    expect(locked.status).toBe(429);
  });

  it('weak / common passwords are rejected', async () => {
    const g = await guest(app);
    const r = await http(app).post('/v1/auth/link/email', { email: 'weak@example.com', password: 'password' }, { token: g.accessToken });
    expect(r.status).toBe(400);
  });

  it('conflict → ACCOUNT_EXISTS + mergeToken → login → merge moves data', async () => {
    const owner = await guest(app);
    await http(app).post('/v1/auth/link/email', { email: 'owner@example.com', password: 'steady-breath-1' }, { token: owner.accessToken });

    const g2 = await guest(app);
    const medId = uuid();
    await db.query(`INSERT INTO meditations (id, user_id, kind, started_at, ended_at, duration_sec, counted, completed, local_date) VALUES ($1,$2,'solo',now()-interval '20 min',now(),1200,true,true,current_date)`, [medId, g2.me.id]);
    await db.query(`INSERT INTO user_daily_stats (user_id, local_date, minutes, meditations) VALUES ($1, current_date, 20, 1)`, [g2.me.id]);

    const c = await http(app).post('/v1/auth/link/email', { email: 'owner@example.com', password: 'steady-breath-1' }, { token: g2.accessToken });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('ACCOUNT_EXISTS');
    const mergeToken = c.body.error.details.mergeToken as string;

    const login = await http(app).post('/v1/auth/email/login', { email: 'owner@example.com', password: 'steady-breath-1' });
    const m = await http(app).post('/v1/auth/merge', { mergeToken }, { token: login.body.data.accessToken });
    expect(m.body.data).toEqual({ merged: true, meditationsMoved: 1 });
    expect((await db.query('SELECT user_id FROM meditations WHERE id=$1', [medId])).rows[0].user_id).toBe(owner.me.id);
    expect((await db.query('SELECT minutes FROM user_daily_stats WHERE user_id=$1', [owner.me.id])).rows[0].minutes).toBe(20);
    expect((await db.query('SELECT 1 FROM users WHERE id=$1', [g2.me.id])).rowCount).toBe(0);
    expect((await http(app).get('/v1/me', { token: g2.accessToken })).status).toBe(401);
    // merge token is single-use
    expect((await http(app).post('/v1/auth/merge', { mergeToken }, { token: login.body.data.accessToken })).body.error.code).toBe('TOKEN_INVALID');
  });

  it('magic link: sign up, single use; no account enumeration', async () => {
    Mailer.outbox = [];
    const r = await http(app).post('/v1/auth/email/magic-link', { email: 'new@example.com' });
    expect(r.status).toBe(202);
    const t = lastMailToken();
    const v = await http(app).post('/v1/auth/email/verify-link', { token: t });
    expect(v.status).toBe(200);
    expect(v.body.data.me).toMatchObject({ isGuest: false, email: 'new@example.com' });
    expect((await http(app).post('/v1/auth/email/verify-link', { token: t })).body.error.code).toBe('TOKEN_INVALID');
    expect((await http(app).post('/v1/auth/password/forgot', { email: 'nobody@example.com' })).status).toBe(202);
  });

  it('password reset signs out every device', async () => {
    const g = await guest(app);
    await http(app).post('/v1/auth/link/email', { email: 'reset@example.com', password: 'old-password-9' }, { token: g.accessToken });
    const session = await http(app).post('/v1/auth/email/login', { email: 'reset@example.com', password: 'old-password-9' });
    Mailer.outbox = [];
    await http(app).post('/v1/auth/password/forgot', { email: 'reset@example.com' });
    expect((await http(app).post('/v1/auth/password/reset', { token: lastMailToken(), password: 'new-password-9' })).status).toBe(200);
    expect((await http(app).get('/v1/me', { token: session.body.data.accessToken })).body.error.code).toBe('TOKEN_INVALID');
    expect((await http(app).post('/v1/auth/refresh', { refreshToken: session.body.data.refreshToken })).body.error.code).toBe('TOKEN_INVALID');
    expect((await http(app).post('/v1/auth/email/login', { email: 'reset@example.com', password: 'new-password-9' })).status).toBe(200);
  });
});

describe('P1 Apple / Google', () => {
  it('Apple: new account, nonce check, guest attach keeps the same user id', async () => {
    const raw = 'nonce-123';
    const tok = await keys.apple!.sign({ sub: 'apple-1', email: 'a@privaterelay.appleid.com', email_verified: 'true', nonce: sha256(raw) });
    const r = await http(app).post('/v1/auth/apple', { idToken: tok, rawNonce: raw, firstName: 'Lena' });
    expect(r.status).toBe(200);
    expect(r.body.data.me).toMatchObject({ isGuest: false, providers: ['apple'], firstName: 'Lena' });
    expect((await http(app).post('/v1/auth/apple', { idToken: tok, rawNonce: 'wrong' })).body.error.code).toBe('TOKEN_INVALID');

    const g = await guest(app);
    const t2 = await keys.apple!.sign({ sub: 'apple-2' });
    const att = await http(app).post('/v1/auth/apple', { idToken: t2 }, { token: g.accessToken });
    expect(att.body.data.me).toMatchObject({ id: g.me.id, isGuest: false });
    expect(att.body.data.mergeToken).toBeNull();
  });

  it('Google: existing account + guest caller → mergeToken; forged token rejected', async () => {
    const t = await keys.google!.sign({ sub: 'google-1', email: 'g@example.com', email_verified: true, given_name: 'Gabi' });
    const first = await http(app).post('/v1/auth/google', { idToken: t });
    const g = await guest(app);
    const again = await http(app).post('/v1/auth/google', { idToken: t }, { token: g.accessToken });
    expect(again.body.data.me.id).toBe(first.body.data.me.id);
    expect(again.body.data.mergeToken).toEqual(expect.any(String));
    const forged = t.slice(0, -4) + 'AAAA';
    expect((await http(app).post('/v1/auth/google', { idToken: forged })).body.error.code).toBe('TOKEN_INVALID');
  });

  it('link conflict for Apple returns ACCOUNT_EXISTS', async () => {
    const g = await guest(app);
    const tok = await keys.apple!.sign({ sub: 'apple-1' });
    const r = await http(app).post('/v1/auth/link/apple', { idToken: tok }, { token: g.accessToken });
    expect(r.status).toBe(409);
    expect(r.body.error.details).toMatchObject({ provider: 'apple', mergeToken: expect.any(String) });
  });
});

describe('P1 gates', () => {
  it('426 UPDATE_REQUIRED for old app versions (auth still works)', async () => {
    await db.query(`UPDATE app_config SET value = jsonb_set(value, '{minVersion,ios}', '"1.2.0"') WHERE key='main'`);
    const { createRedis, K } = await import('../src/infra/redis').then((m) => ({ createRedis: m.createRedis, K: m.K }));
    const r = createRedis(); await r.del(K.config('main')); await r.quit();
    const g = await guest(app);
    const old = await http(app).get('/v1/me', { token: g.accessToken, headers: { 'x-app-version': '1.1.9' } });
    expect(old.status).toBe(426);
    expect(old.body.error.code).toBe('UPDATE_REQUIRED');
    expect((await http(app).get('/v1/me', { token: g.accessToken, headers: { 'x-app-version': '1.2.0' } })).status).toBe(200);
    expect((await http(app).get('/v1/time', { headers: { 'x-app-version': '0.1.0' } })).status).toBe(200);
  });

  it('rate limit: auth bucket 10/min per IP with Retry-After', async () => {
    const h = { headers: { 'x-forwarded-for': '7.7.7.7' } };
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await http(app).post('/v1/auth/guest', { installId: `rl-install-${i}xx`, platform: 'ios', appVersion: '1.2.0' }, h)).status);
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    const last = await http(app).post('/v1/auth/guest', { installId: 'rl-install-zz', platform: 'ios', appVersion: '1.2.0' }, h);
    expect(last.status).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });
});
