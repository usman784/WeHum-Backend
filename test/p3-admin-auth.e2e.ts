import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { Mailer } from '../src/infra/mailer';
import { ADMIN_PASSWORD, adminToken, bootApp, cookiesOf, http, makeAdmin, resetTestDb, totp } from './helpers';

let app: NestFastifyApplication;
let db: Client;
const h = () => http(app);
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const lastLink = () => Mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1]!;
const ip = (n: number) => ({ 'x-forwarded-for': `20.0.0.${n}` });
const cookieHeader = (c: ReturnType<typeof cookiesOf>) => `wh_rt=${c.wh_rt!.value}; wh_csrf=${c.wh_csrf!.value}`;

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
afterAll(async () => { await db?.end(); await app?.close(); });

/** Full sign-in for a made admin (password → TOTP). */
async function signIn(a: { email: string; secret: string; password: string }, step = 0, headers = ip(1)) {
  const l = await h().post('/v1/admin/auth/login', { email: a.email, password: a.password }, { headers });
  expect(l.status).toBe(200);
  const v = await h().post('/v1/admin/auth/mfa/verify', { mfaToken: l.body.data.mfaToken, code: totp(a.secret, step) }, { headers });
  return { res: v, cookies: cookiesOf(v.headers), token: v.body.data?.accessToken as string };
}

describe('P3 admin sign-in', () => {
  it('first login: password → enroll TOTP (QR + 10 recovery codes) → session', async () => {
    const owner = (await q<{ email: string }>(`SELECT email FROM admin_users WHERE role='owner'`))[0]!.email;
    const l = await h().post('/v1/admin/auth/login', { email: owner, password: 'ChangeMe-2026!' }, { headers: ip(2) });
    expect(l.status).toBe(200);
    expect(l.body.data.step).toBe('enroll');
    const enrollToken = l.body.data.enrollToken as string;

    const start = await h().post('/v1/admin/auth/mfa/enroll', { enrollToken }, { headers: ip(2) });
    expect(start.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\/WeHum%20CMS:/);
    const secret = start.body.data.secret as string;
    expect((await h().post('/v1/admin/auth/mfa/enroll', { enrollToken }, { headers: ip(2) })).body.data.secret).toBe(secret); // stable until confirmed

    const bad = await h().post('/v1/admin/auth/mfa/enroll', { enrollToken, code: '000000' }, { headers: ip(2) });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('MFA_REQUIRED');

    const ok = await h().post('/v1/admin/auth/mfa/enroll', { enrollToken, code: totp(secret) }, { headers: ip(2) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.recoveryCodes).toHaveLength(10);
    expect(ok.body.data.admin).toMatchObject({ email: owner, role: 'owner', mfaEnabled: true });
    expect(ok.body.data.admin.permissions).toEqual(expect.arrayContaining(['team.manage', 'settings']));
    expect(ok.headers['cache-control']).toBe('no-store');
    const c = cookiesOf(ok.headers);
    expect(c.wh_rt!.flags).toMatch(/httponly/);
    expect(c.wh_rt!.flags).toMatch(/secure/);
    expect(c.wh_rt!.flags).toMatch(/samesite=strict/);
    expect(c.wh_rt!.flags).toMatch(/path=\/v1\/admin\/auth/);
    expect(c.wh_csrf!.flags).not.toMatch(/httponly/);
    expect(c.wh_csrf!.value).toBe(ok.body.data.csrfToken);
    expect(ok.body.data.refreshToken).toBeUndefined(); // refresh token only ever travels in the cookie

    const me = await h().get('/v1/admin/me', { token: ok.body.data.accessToken });
    expect(me.body.data).toMatchObject({ email: owner, role: 'owner' });
    // secret is encrypted at rest
    const row = (await q<{ totp_secret: string }>(`SELECT totp_secret FROM admin_users WHERE email=$1`, [owner]))[0]!;
    expect(row.totp_secret).not.toContain(secret);
    // the enroll token is single-use
    expect((await h().post('/v1/admin/auth/mfa/enroll', { enrollToken, code: totp(secret, 1) }, { headers: ip(2) })).body.error.code).toBe('TOKEN_INVALID');
  });

  it('later logins need password then a TOTP code; a code works only once; recovery codes work once', async () => {
    const a = await makeAdmin(db, 'admin');
    const first = await signIn(a);
    expect(first.res.status).toBe(200);
    expect(first.token).toEqual(expect.any(String));

    const l = await h().post('/v1/admin/auth/login', { email: a.email, password: a.password }, { headers: ip(1) });
    expect(l.body.data.step).toBe('mfa');
    const replay = await h().post('/v1/admin/auth/mfa/verify', { mfaToken: l.body.data.mfaToken, code: totp(a.secret) }, { headers: ip(1) });
    expect(replay.body.error.code).toBe('MFA_REQUIRED'); // same code as the first login
    const next = await h().post('/v1/admin/auth/mfa/verify', { mfaToken: l.body.data.mfaToken, code: totp(a.secret, 1) }, { headers: ip(1) });
    expect(next.status).toBe(200);

    // recovery code
    const codes = ['abcde-12345'];
    const crypto = await import('node:crypto');
    await q(`UPDATE admin_users SET recovery_codes = $2 WHERE id=$1`, [a.id, codes.map((c) => crypto.createHash('sha256').update(c).digest('hex'))]);
    const l2 = await h().post('/v1/admin/auth/login', { email: a.email, password: a.password }, { headers: ip(1) });
    const rc = await h().post('/v1/admin/auth/mfa/verify', { mfaToken: l2.body.data.mfaToken, recoveryCode: 'ABCDE-12345' }, { headers: ip(1) });
    expect(rc.status).toBe(200);
    const l3 = await h().post('/v1/admin/auth/login', { email: a.email, password: a.password }, { headers: ip(1) });
    expect((await h().post('/v1/admin/auth/mfa/verify', { mfaToken: l3.body.data.mfaToken, recoveryCode: 'abcde-12345' }, { headers: ip(1) })).status).toBe(401);
  });

  it('wrong or unknown credentials give the same answer; input is validated', async () => {
    const a = await makeAdmin(db, 'editor');
    const wrong = await h().post('/v1/admin/auth/login', { email: a.email, password: 'nope-nope-nope' }, { headers: ip(3) });
    const unknown = await h().post('/v1/admin/auth/login', { email: 'ghost@wehum.test', password: 'nope-nope-nope' }, { headers: ip(3) });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: wrong.body.error.message });
    expect((await h().post('/v1/admin/auth/login', { email: 'x' }, { headers: ip(3) })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await h().post('/v1/admin/auth/mfa/verify', { mfaToken: 'x'.repeat(30), code: '123456' }, { headers: ip(3) })).body.error.code).toBe('TOKEN_INVALID');
    expect((await h().post('/v1/admin/auth/mfa/verify', { mfaToken: 'x'.repeat(30) }, { headers: ip(3) })).status).toBe(400);
  });

  it('5 wrong passwords lock the account for 15 minutes (429 + Retry-After), even for the right password', async () => {
    const a = await makeAdmin(db, 'editor');
    for (let i = 0; i < 5; i++) expect((await h().post('/v1/admin/auth/login', { email: a.email, password: 'wrong-password-1' }, { headers: ip(10 + i) })).status).toBe(401);
    const locked = await h().post('/v1/admin/auth/login', { email: a.email, password: a.password }, { headers: ip(20) });
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toMatch(/15 minutes/);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    await q(`UPDATE admin_users SET locked_until = now() - interval '1 second' WHERE id=$1`, [a.id]);
    expect((await h().post('/v1/admin/auth/login', { email: a.email, password: a.password }, { headers: ip(21) })).status).toBe(200);
  });

  it('5 wrong TOTP codes also lock', async () => {
    const a = await makeAdmin(db, 'editor');
    const l = await h().post('/v1/admin/auth/login', { email: a.email, password: a.password }, { headers: ip(30) });
    for (let i = 0; i < 5; i++) await h().post('/v1/admin/auth/mfa/verify', { mfaToken: l.body.data.mfaToken, code: '111111' }, { headers: ip(30) });
    const r = await h().post('/v1/admin/auth/mfa/verify', { mfaToken: l.body.data.mfaToken, code: totp(a.secret) }, { headers: ip(30) });
    expect(r.status).toBe(429);
  });

  it('disabled and invited admins cannot sign in', async () => {
    const a = await makeAdmin(db, 'editor');
    await q(`UPDATE admin_users SET status='disabled' WHERE id=$1`, [a.id]);
    expect((await h().post('/v1/admin/auth/login', { email: a.email, password: a.password }, { headers: ip(31) })).body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('P3 admin refresh cookie + CSRF', () => {
  it('rotates the cookie; needs the CSRF header; old cookie is dead; wrong origin refused', async () => {
    const a = await makeAdmin(db, 'admin');
    const s = await signIn(a, 0, ip(40));
    const cookie = cookieHeader(s.cookies);

    expect((await h().post('/v1/admin/auth/refresh', {}, { headers: { cookie } })).body.error.code).toBe('FORBIDDEN'); // no X-CSRF
    expect((await h().post('/v1/admin/auth/refresh', {}, { headers: { cookie, 'x-csrf': 'wrong' } })).status).toBe(403);
    expect((await h().post('/v1/admin/auth/refresh', {}, { headers: { cookie, 'x-csrf': s.cookies.wh_csrf!.value, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await h().post('/v1/admin/auth/refresh', {})).status).toBe(401); // no cookie

    const ok = await h().post('/v1/admin/auth/refresh', {}, { headers: { cookie, 'x-csrf': s.cookies.wh_csrf!.value, origin: 'http://localhost:5173' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.admin.role).toBe('admin');
    const c2 = cookiesOf(ok.headers);
    expect(c2.wh_rt!.value).not.toBe(s.cookies.wh_rt!.value);
    expect((await h().get('/v1/admin/me', { token: ok.body.data.accessToken })).status).toBe(200);

    const again = await h().post('/v1/admin/auth/refresh', {}, { headers: { cookie, 'x-csrf': s.cookies.wh_csrf!.value } });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('TOKEN_INVALID');
    // the rotated cookie keeps working; by default the CSRF cookie is host-only
    expect(c2.wh_csrf!.flags).not.toMatch(/domain=/);
    env.ADMIN_COOKIE_DOMAIN = '.wehum.test'; // CMS and API on different subdomains
    try {
      const sub = await h().post('/v1/admin/auth/refresh', {}, { headers: { cookie: cookieHeader(c2), 'x-csrf': c2.wh_csrf!.value } });
      expect(sub.status).toBe(200);
      const c3 = cookiesOf(sub.headers);
      expect(c3.wh_csrf!.flags).toMatch(/domain=\.wehum\.test/); // readable by cms.wehum.test
      expect(c3.wh_rt!.flags).not.toMatch(/domain=/); // the refresh cookie stays on the API host
    } finally {
      env.ADMIN_COOKIE_DOMAIN = '';
    }
  });

  it('12 h idle timeout and 7 d absolute limit', async () => {
    const a = await makeAdmin(db, 'admin');
    const s = await signIn(a, 1, ip(41));
    const hdr = { cookie: cookieHeader(s.cookies), 'x-csrf': s.cookies.wh_csrf!.value };
    await q(`UPDATE admin_sessions SET last_used_at = now() - interval '13 hours' WHERE admin_id=$1`, [a.id]);
    expect((await h().post('/v1/admin/auth/refresh', {}, { headers: hdr })).body.error.code).toBe('TOKEN_INVALID');

    const s2 = await signIn(a, -1, ip(41));
    await q(`UPDATE admin_sessions SET expires_at = now() - interval '1 minute' WHERE admin_id=$1 AND revoked_at IS NULL`, [a.id]);
    expect((await h().post('/v1/admin/auth/refresh', {}, { headers: { cookie: cookieHeader(s2.cookies), 'x-csrf': s2.cookies.wh_csrf!.value } })).status).toBe(401);
  });

  it('logout kills the refresh cookie', async () => {
    const a = await makeAdmin(db, 'editor');
    const s = await signIn(a, 0, ip(42));
    const hdr = { cookie: cookieHeader(s.cookies), 'x-csrf': s.cookies.wh_csrf!.value };
    const out = await h().post('/v1/admin/auth/logout', {}, { token: s.token, headers: hdr });
    expect(out.status).toBe(204);
    expect(cookiesOf(out.headers).wh_rt!.flags).toMatch(/expires=thu, 01 jan 1970|max-age=0/);
    expect((await h().post('/v1/admin/auth/refresh', {}, { headers: hdr })).status).toBe(401);
    expect((await h().post('/v1/admin/auth/logout', {})).status).toBe(401);
  });
});

describe('P3 password reset', () => {
  it('forgot never reveals accounts; reset signs out everywhere and unlocks', async () => {
    const a = await makeAdmin(db, 'admin');
    const s = await signIn(a, 0, ip(50));
    Mailer.outbox = [];
    expect((await h().post('/v1/admin/auth/forgot', { email: 'ghost@wehum.test' }, { headers: ip(50) })).status).toBe(202);
    expect(Mailer.outbox).toHaveLength(0);
    expect((await h().post('/v1/admin/auth/forgot', { email: a.email }, { headers: ip(50) })).status).toBe(202);
    expect(Mailer.outbox[0]!.to).toBe(a.email);
    const token = lastLink();

    expect((await h().post('/v1/admin/auth/reset', { token, password: 'password123' }, { headers: ip(50) })).status).toBe(400); // common
    const r = await h().post('/v1/admin/auth/reset', { token, password: 'Brand-New-Pass-77' }, { headers: ip(50) });
    expect(r.status).toBe(200);
    expect((await h().post('/v1/admin/auth/reset', { token, password: 'Another-Pass-88x' }, { headers: ip(50) })).body.error.code).toBe('TOKEN_INVALID'); // single use

    expect((await h().get('/v1/admin/me', { token: s.token })).body.error.code).toBe('TOKEN_INVALID'); // old access token
    expect((await h().post('/v1/admin/auth/refresh', {}, { headers: { cookie: cookieHeader(s.cookies), 'x-csrf': s.cookies.wh_csrf!.value } })).status).toBe(401);
    expect((await h().post('/v1/admin/auth/login', { email: a.email, password: a.password }, { headers: ip(50) })).status).toBe(401);
    expect((await h().post('/v1/admin/auth/login', { email: a.email, password: 'Brand-New-Pass-77' }, { headers: ip(50) })).body.data.step).toBe('mfa');
  });
});

describe('P3 team, invites and role protection', () => {
  it('owner invites an editor → mail → accept → enroll MFA → session as editor', async () => {
    const owner = await makeAdmin(db, 'owner');
    const t = await adminToken(app, owner);
    Mailer.outbox = [];
    const inv = await h().post('/v1/admin/team/invite', { email: 'Newbie@Wehum.Test', role: 'editor' }, { token: t });
    expect(inv.status).toBe(201);
    expect(inv.body.data).toMatchObject({ email: 'newbie@wehum.test', role: 'editor', status: 'invited', mfaEnabled: false });
    expect(Mailer.outbox[0]!.subject).toMatch(/invited/);
    const token = lastLink();
    expect((await h().post('/v1/admin/team/invite', { email: 'newbie@wehum.test', role: 'editor' }, { token: t })).body.error.code).toBe('ALREADY_EXISTS');
    expect((await h().post('/v1/admin/auth/login', { email: 'newbie@wehum.test', password: 'whatever-1234' }, { headers: ip(60) })).status).toBe(401); // not active yet

    const acc = await h().post('/v1/admin/auth/accept-invite', { token, name: 'Nina Newbie', password: 'Fresh-Start-2026' }, { headers: ip(60) });
    expect(acc.status).toBe(200);
    expect(acc.body.data.step).toBe('enroll');
    const sec = (await h().post('/v1/admin/auth/mfa/enroll', { enrollToken: acc.body.data.enrollToken }, { headers: ip(60) })).body.data.secret as string;
    const done = await h().post('/v1/admin/auth/mfa/enroll', { enrollToken: acc.body.data.enrollToken, code: totp(sec) }, { headers: ip(60) });
    expect(done.body.data.admin).toMatchObject({ name: 'Nina Newbie', role: 'editor' });
    expect((await h().post('/v1/admin/auth/accept-invite', { token, name: 'x', password: 'Fresh-Start-2026' }, { headers: ip(60) })).body.error.code).toBe('TOKEN_INVALID');
    const list = await h().get('/v1/admin/team', { token: t });
    expect(list.body.data.find((m: { email: string }) => m.email === 'newbie@wehum.test')).toMatchObject({ status: 'active', mfaEnabled: true });
  });

  it('admins cannot invite or touch owners', async () => {
    const admin = await makeAdmin(db, 'admin'), owner = await makeAdmin(db, 'owner');
    const t = await adminToken(app, admin);
    expect((await h().post('/v1/admin/team/invite', { email: 'o2@wehum.test', role: 'owner' }, { token: t })).body.error.code).toBe('FORBIDDEN');
    expect((await h().patch(`/v1/admin/team/${owner.id}`, { status: 'disabled' }, { token: t })).status).toBe(403);
    expect((await h().del(`/v1/admin/team/${owner.id}`, { token: t })).status).toBe(403);
    const editor = await makeAdmin(db, 'editor');
    expect((await h().patch(`/v1/admin/team/${editor.id}`, { role: 'owner' }, { token: t })).status).toBe(403);
    expect((await h().patch(`/v1/admin/team/${editor.id}`, { role: 'moderator' }, { token: t })).body.data.role).toBe('moderator');
  });

  it('the last active owner is protected; nobody removes or demotes themselves', async () => {
    await q(`UPDATE admin_users SET status='disabled' WHERE role='owner'`);
    const owner = await makeAdmin(db, 'owner');
    const t = await adminToken(app, owner);
    expect((await h().patch(`/v1/admin/team/${owner.id}`, { role: 'admin' }, { token: t })).body.error.code).toBe('INVALID_STATE'); // self
    const second = await makeAdmin(db, 'owner');
    expect((await h().patch(`/v1/admin/team/${second.id}`, { role: 'admin' }, { token: t })).status).toBe(200); // two owners → ok
    const third = await makeAdmin(db, 'owner');
    await q(`UPDATE admin_users SET status='disabled' WHERE id=$1`, [third.id]);
    // only `owner` remains active → another owner (the demoted one's replacement) cannot be removed by itself, and the only owner can't be changed by an admin either
    const a2 = await makeAdmin(db, 'admin');
    const t2 = await adminToken(app, a2);
    expect((await h().del(`/v1/admin/team/${owner.id}`, { token: t2 })).status).toBe(403);
    const ot = await makeAdmin(db, 'owner');
    const tt = await adminToken(app, ot);
    await q(`UPDATE admin_users SET status='disabled' WHERE id=$1`, [owner.id]);
    expect((await h().patch(`/v1/admin/team/${ot.id}`, { status: 'disabled' }, { token: tt })).body.error.code).toBe('INVALID_STATE'); // self first
  });

  it('role change / disable signs the admin out; remove deletes them', async () => {
    const owner = await makeAdmin(db, 'owner'), editor = await makeAdmin(db, 'editor');
    const ot = await adminToken(app, owner);
    const s = await signIn(editor, 0, ip(70));
    const patch = await h().patch(`/v1/admin/team/${editor.id}`, { role: 'moderator' }, { token: ot });
    expect(patch.body.data.role).toBe('moderator');
    expect((await h().get('/v1/admin/me', { token: s.token })).body.error.code).toBe('TOKEN_INVALID');
    expect((await h().post('/v1/admin/auth/refresh', {}, { headers: { cookie: cookieHeader(s.cookies), 'x-csrf': s.cookies.wh_csrf!.value } })).status).toBe(401);
    const s2 = await signIn(editor, 1, ip(70));
    expect((await h().get('/v1/admin/me', { token: s2.token })).body.data.role).toBe('moderator'); // new role after sign-in

    expect((await h().patch(`/v1/admin/team/${editor.id}`, { status: 'disabled' }, { token: ot })).body.data.status).toBe('disabled');
    expect((await h().get('/v1/admin/me', { token: s2.token })).status).toBe(401);
    expect((await h().del(`/v1/admin/team/${editor.id}`, { token: ot })).status).toBe(204);
    expect((await h().del(`/v1/admin/team/${editor.id}`, { token: ot })).status).toBe(404);
  });

  it('team routes: owner/admin only; every change is in the audit log', async () => {
    const editor = await makeAdmin(db, 'editor'), mod = await makeAdmin(db, 'moderator'), admin = await makeAdmin(db, 'admin');
    for (const r of [editor, mod]) {
      const t = await adminToken(app, r);
      expect((await h().get('/v1/admin/team', { token: t })).status).toBe(403);
      expect((await h().get('/v1/admin/audit', { token: t })).status).toBe(403);
    }
    expect((await h().get('/v1/admin/team')).status).toBe(401);
    expect((await h().get('/v1/admin/team', { token: 'garbage' })).status).toBe(401);
    const t = await adminToken(app, admin);
    expect((await h().get('/v1/admin/team', { token: t })).status).toBe(200);
    // an app (guest) token is not an admin token
    const { guest } = await import('./helpers');
    const g = await guest(app);
    expect((await h().get('/v1/admin/team', { token: g.accessToken })).status).toBe(401);

    const log = await h().get('/v1/admin/audit?targetType=admin&limit=100', { token: t });
    expect(log.status).toBe(200);
    expect(log.body.data.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['team.invite', 'team.update', 'team.remove']));
    const entry = log.body.data.find((e: { action: string; actorRole: string }) => e.action === 'team.update' && e.actorRole === 'admin');
    expect(entry).toMatchObject({ actorRole: 'admin', before: expect.any(Object), after: expect.any(Object), requestId: expect.any(String) });
  });
});
