import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SocialVerifier } from '../src/modules/auth/social.verifier';
import { baseFrom, validateUsername } from '../src/modules/me/username.service';
import { bootApp, clearRates, guest, http, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let signGoogle: (c: Record<string, unknown>) => Promise<string>;
const h = () => http(app);
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
// 1×1 PNG
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a5f645400000000049454e44ae426082', 'hex'), Buffer.alloc(60)]).toString('base64');

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

describe('username rules', () => {
  it('validates shape and reserved words', () => {
    expect(validateUsername('Jane.Doe_1')).toEqual({ ok: true, value: 'jane.doe_1' });
    for (const bad of ['ab', 'a'.repeat(21), 'has space', '.lead', 'trail.', 'dou..ble', 'admin', 'emoji😀x']) expect(validateUsername(bad).ok).toBe(false);
    expect(baseFrom('Jane.Doe+news@Example.com')).toBe('jane.doe');
    expect(baseFrom('éa@x.com').length).toBeGreaterThanOrEqual(3);
  });
});

describe('profile: username, names, photo', () => {
  it('check + suggest: availability, reasons, alternatives', async () => {
    const g = await guest(app);
    const ok = await h().get('/v1/me/username/check?u=quiet_mind', { token: g.accessToken });
    expect(ok.body.data).toMatchObject({ available: true, reason: null });
    expect(ok.body.data.suggestions.length).toBeGreaterThan(0);
    expect((await h().get('/v1/me/username/check?u=a', { token: g.accessToken })).body.data).toMatchObject({ available: false, reason: 'Use 3 to 20 characters' });
    const sug = await h().get('/v1/me/username/suggest?seed=Raphael%20Reiter', { token: g.accessToken });
    expect(sug.body.data.suggestions.every((s: string) => validateUsername(s).ok)).toBe(true);
  });

  it('email sign-up takes a username and a last name; the name is then taken for others', async () => {
    const g = await guest(app);
    const r = await h().post('/v1/auth/link/email', { email: 'jane@x.test', password: 'Sup3r-secret-pw', firstName: 'Jane', lastName: 'Doe', username: 'Jane.Doe' }, { token: g.accessToken });
    expect(r.status).toBe(200);
    const me = (await h().get('/v1/me', { token: r.body.data.accessToken })).body.data;
    expect(me).toMatchObject({ username: 'jane.doe', firstName: 'Jane', lastName: 'Doe', usernameChangedAt: null });
    const g2 = await guest(app);
    const clash = await h().post('/v1/auth/link/email', { email: 'jane2@x.test', password: 'Sup3r-secret-pw', username: 'JANE.doe' }, { token: g2.accessToken });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details.suggestions.length).toBeGreaterThan(0);
  });

  it('a username changes once per 7 days; names and photo change freely; the e-mail never does', async () => {
    const g = await guest(app);
    const link = await h().post('/v1/auth/link/email', { email: 'ken@x.test', password: 'Sup3r-secret-pw', firstName: 'Ken', username: 'ken.one' }, { token: g.accessToken });
    const t = link.body.data.accessToken as string;
    const first = await h().patch('/v1/me', { username: 'ken.two', firstName: 'Kenji', lastName: 'Sato' }, { token: t });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ username: 'ken.two', firstName: 'Kenji', lastName: 'Sato' });
    expect(first.body.data.usernameNextChangeAt).toBeTruthy();
    const again = await h().patch('/v1/me', { username: 'ken.three' }, { token: t });
    expect(again.status).toBe(429);
    expect(again.body.error.details.nextChangeAt).toBeTruthy();
    expect((await h().patch('/v1/me', { firstName: 'Ken', lastName: null }, { token: t })).body.data).toMatchObject({ firstName: 'Ken', lastName: null, username: 'ken.two' });
    expect((await h().patch('/v1/me', { email: 'other@x.test' }, { token: t })).status).toBe(400);
    expect((await h().patch('/v1/me', { username: 'ken.two' }, { token: t })).status).toBe(200); // same name is not a change
    await q(`UPDATE users SET username_changed_at = now() - interval '8 days' WHERE username = 'ken.two'`);
    expect((await h().patch('/v1/me', { username: 'ken.three' }, { token: t })).body.data.username).toBe('ken.three');
    const taken = await h().patch('/v1/me', { username: 'jane.doe' }, { token: t });
    expect([409, 429]).toContain(taken.status);

    const up = await h().request('PUT', '/v1/me/avatar', { body: { contentType: 'image/png', data: PNG }, token: t });
    expect(up.status).toBe(200);
    expect(up.body.data.avatarUrl).toMatch(/avatars\//);
    expect((await h().request('PUT', '/v1/me/avatar', { body: { contentType: 'image/png', data: Buffer.alloc(300).toString('base64') }, token: t })).status).toBe(400);
    expect((await h().request('DELETE', '/v1/me/avatar', { token: t })).body.data.avatarUrl).toBeNull();
  });

  it('social sign-in creates a username from the e-mail and keeps the provider photo', async () => {
    const tok = await signGoogle({ sub: 'g-demo-1', email: 'Sam.Rivera+promo@gmail.com', email_verified: true, given_name: 'Sam', family_name: 'Rivera', picture: 'https://lh3.googleusercontent.com/a/sam' });
    const r = await h().post('/v1/auth/google', { idToken: tok });
    expect(r.status).toBe(200);
    const me = (await h().get('/v1/me', { token: r.body.data.accessToken })).body.data;
    expect(me.username).toMatch(/^sam\.rivera/);
    expect(me).toMatchObject({ firstName: 'Sam', lastName: 'Rivera', avatarUrl: 'https://lh3.googleusercontent.com/a/sam', usernameChangedAt: null });
    // a second person with the same address base gets a different handle
    const tok2 = await signGoogle({ sub: 'g-demo-2', email: 'sam.rivera@outlook.com', email_verified: true });
    const me2 = (await h().get('/v1/me', { token: (await h().post('/v1/auth/google', { idToken: tok2 })).body.data.accessToken })).body.data;
    expect(me2.username).not.toBe(me.username);
  });
});

describe('branding, push cap and daily-message schedule', () => {
  it('bootstrap carries the app name and logo from Settings', async () => {
    const g = await guest(app);
    expect((await h().get('/v1/bootstrap', { token: g.accessToken })).body.data.branding).toEqual({ appName: 'WeHum', tagline: 'Meditate together', logoUrl: null });
    await q(`INSERT INTO app_config (key, value, version) VALUES ('branding', $1, 1) ON CONFLICT (key) DO UPDATE SET value = $1, version = 2`, [JSON.stringify({ appName: 'Calm Club', tagline: 'Sit together', logoMediaId: null })]);
    const { K } = await import('../src/infra/redis');
    const Redis = (await import('ioredis')).default; const r = new Redis(process.env.REDIS_URL!); await r.del(K.config('branding')); await r.quit();
    expect((await h().get('/v1/bootstrap', { token: g.accessToken })).body.data.branding).toMatchObject({ appName: 'Calm Club', tagline: 'Sit together' });
  });
});

describe('push cap and tracking', () => {
  it('a person gets at most `push.maxPerDay` pushes a day; the delivery report shows who hit the cap', async () => {
    const { PushService } = await import('../src/modules/push/push.service');
    const { adminToken, makeAdmin } = await import('./helpers');
    const g = await guest(app);
    const svc = app.get(PushService) as unknown as { claim: (rows: { userId: string; date: string }[], key: string) => Promise<Set<string>> };
    const date = new Date().toISOString().slice(0, 10), row = [{ userId: g.me.id, date }];
    expect((await svc.claim(row, 'daily_nudge')).size).toBe(1);
    expect((await svc.claim(row, 'daily_message')).size).toBe(1);
    expect((await svc.claim(row, 'group_warning')).size).toBe(0); // third push of the day: held back
    const admin = await adminToken(app, await makeAdmin(db, 'owner'));
    const rep = await h().get('/v1/admin/notifications/delivery?days=7', { token: admin });
    expect(rep.status).toBe(200);
    expect(rep.body.data.maxPerDay).toBe(2);
    const today = rep.body.data.days.find((d: { date: string }) => d.date === date);
    expect(today).toMatchObject({ people: 1, atCap: 1, sent: 2 });
    const detail = await h().get(`/v1/admin/users/${g.me.id}`, { token: admin });
    expect(detail.body.data.pushes).toHaveLength(2);
  });

  it('a daily message scheduled for a moment goes live then, not before; push time is stored', async () => {
    const { PublishDueService } = await import('../src/jobs/publish-due.service');
    const { adminToken, makeAdmin } = await import('./helpers');
    const admin = await adminToken(app, await makeAdmin(db, 'owner'));
    const day = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const put = (body: Record<string, unknown>) => h().request('PUT', `/v1/admin/daily-messages/${day}`, { body: { type: 'text', title: 'Later', text: 'Hello', status: 'scheduled', access: 'free', pushTime: '08:30', ...body }, token: admin });
    const a = await put({ publishAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ status: 'scheduled', pushTime: '08:30' });
    await app.get(PublishDueService).publishMessages();
    expect((await q<{ status: string }>(`SELECT status FROM daily_messages WHERE date = $1`, [day]))[0]!.status).toBe('scheduled');
    await q(`UPDATE daily_messages SET publish_at = now() - interval '1 minute' WHERE date = $1`, [day]);
    await app.get(PublishDueService).publishMessages();
    expect((await q<{ status: string }>(`SELECT status FROM daily_messages WHERE date = $1`, [day]))[0]!.status).toBe('live');
  });
});

describe('inbox delete', () => {
  it('a person deletes one notification (only their own) or clears them all', async () => {
    const a = await guest(app), b = await guest(app);
    const { v7: uuid } = await import('uuid');
    const ids = [uuid(), uuid()], other = uuid();
    for (const id of ids) await q(`INSERT INTO inbox_items (id, user_id, type, title, body) VALUES ($1,$2,'daily','t','b')`, [id, a.me.id]);
    await q(`INSERT INTO inbox_items (id, user_id, type, title, body) VALUES ($1,$2,'daily','t','b')`, [other, b.me.id]);
    expect((await h().request('DELETE', `/v1/me/inbox/${ids[0]}`, { token: a.accessToken })).status).toBe(204);
    expect((await h().request('DELETE', `/v1/me/inbox/${other}`, { token: a.accessToken })).status).toBe(404); // not theirs
    expect((await h().get('/v1/me/inbox', { token: a.accessToken })).body.data).toHaveLength(1);
    expect((await h().request('DELETE', '/v1/me/inbox', { token: a.accessToken })).body.data.removed).toBe(1);
    expect((await h().get('/v1/me/inbox', { token: b.accessToken })).body.data).toHaveLength(1);
  });
});
