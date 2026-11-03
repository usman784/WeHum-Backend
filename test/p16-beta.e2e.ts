// Beta tester management: generation, passwords, premium grants, live updates, suspension, deletion, scope and RBAC.
// Fixtures only: every account here lives in the throw-away test database.
import argon2 from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import type { Socket } from 'socket.io-client';
import { v7 as uuid } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { REDIS } from '../src/infra/redis';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { BetaService } from '../src/modules/beta/beta.service';
import { initialPassword, loginFor, parseImport, passwordOk } from '../src/modules/beta/beta.logins';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { RcProcessor } from '../src/modules/subscriptions/rc.processor';
import { RevenueCatClient } from '../src/modules/subscriptions/revenuecat.client';
import { UserDataService } from '../src/modules/users-admin/user-data.service';
import { account, adminToken, clearRates, guest, http, makeAdmin, resetTestDb } from './helpers';
import { connect, mustConnect, recorder, sleep, startPod, waitFor } from './realtime-helpers';

let pod: Awaited<ReturnType<typeof startPod>>;
let app: NestFastifyApplication;
let db: Client;
let owner: string, editor: string, moderator: string;
let sockets: Socket[] = [];
const track = (s: Socket) => { sockets.push(s); return s; };
const q = async <T = Record<string, any>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const beta = () => app.get(BetaService);
const ent = () => app.get(EntitlementService);
const A = (token: string) => ({ get: (u: string) => http(app).get(u, { token }), post: (u: string, b?: unknown) => http(app).post(u, b, { token }) });
const DOMAIN = 'testers.wehum.test';
const today = () => new Date().toISOString().slice(0, 10);

/** Creates a batch through the API and runs its job, as the worker would. */
async function makeBatch(over: Record<string, unknown> = {}) {
  const body = { name: 'Beta Round 1', count: 6, prefix: 'beta', access: 'mixed', premiumCount: 4, premiumDays: 30, seedPreset: 'blank', ...over };
  const r = await A(owner).post('/v1/admin/beta/batches', body);
  if (r.status !== 202) throw new Error(`batch failed ${r.status} ${JSON.stringify(r.body)}`);
  await beta().runGenerate(r.body.data.jobId, r.body.data.batchId);
  return r.body.data as { batchId: string; jobId: string };
}
const FREE = { access: 'free', premiumCount: undefined, premiumDays: undefined };
const idOf = async (login: string) => (await q<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [login]))[0]!.id;
const signIn = (login: string, password = initialPassword(login)) => http(app).post('/v1/auth/email/login', { email: `${login}@${DOMAIN}`, password, ...{} }, {});
const act = (id: string, action: string, params: Record<string, unknown> = {}, tok = owner) => A(tok).post(`/v1/admin/beta/users/${id}/action`, { action, params });
const member = async (login: string) => (await signIn(login)).body.data as { accessToken: string; refreshToken: string; me: { id: string; entitlement: Record<string, any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  await resetTestDb();
  pod = await startPod();
  app = pod.app;
  // RevenueCat is never called for real: an unknown subscriber is a 404
  app.get(RevenueCatClient).fetchImpl = (async () => new Response('{}', { status: 404 })) as typeof fetch;
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  owner = await adminToken(app, await makeAdmin(db, 'owner'));
  editor = await adminToken(app, await makeAdmin(db, 'editor'));
  moderator = await adminToken(app, await makeAdmin(db, 'moderator'));
});
afterEach(async () => { for (const s of sockets) s.close(); sockets = []; await clearRates(); await sleep(30); });
afterAll(async () => { await db?.end(); await pod?.stop(); });

describe('pure rules', () => {
  it('password is the complete login plus "we", lowercase, leading zeroes kept', () => {
    expect(initialPassword('beta001')).toBe('beta001we');
    expect(initialPassword(loginFor('beta', 2))).toBe('beta002we');
    expect(initialPassword(loginFor('beta', 3))).toBe('beta003we');
    expect(passwordOk('beta001')).toBe(true);
    expect(passwordOk('be001')).toBe(false); // 'be001we' is 7 characters: the member policy is not weakened
  });
  it('CSV import validates every row', () => {
    const { rows } = parseImport('login,display_name,access,premium_days\nabc201,Ann,free,\nabc201,Dup,free,\nXY,Bad,premium,\nabc203,,premium,30\n', 50);
    expect(rows.map((r) => r.errors.length > 0)).toEqual([false, true, true, false]);
    expect(rows[3]).toMatchObject({ premium: true, days: 30 });
  });
});

describe('1 · generate 150 accounts: 100 premium + 50 free', () => {
  let batchId = '';
  it('creates unique logins with the requested initial passwords, stored only as hashes', async () => {
    expect((await A(owner).post('/v1/admin/beta/batches', { name: 'x1', count: 5, prefix: 'be', access: 'free' })).status).toBe(400); // prefix too short for the policy
    const pre = await A(owner).post('/v1/admin/beta/batches/preview', { name: 'Beta Round 1', count: 150, prefix: 'beta', access: 'mixed', premiumCount: 100, freeCount: 50, premiumDays: 30 });
    expect(pre.body.data).toMatchObject({ total: 150, premium: 100, free: 50, passwordStyle: 'Username + we (example: beta001we)' });
    expect(pre.body.data.examples[0]).toMatchObject({ login: 'beta001', password: 'beta001we' });
    expect((await A(owner).post('/v1/admin/beta/batches/preview', { name: 'x2', count: 150, prefix: 'beta', access: 'mixed', premiumCount: 100, freeCount: 40, premiumDays: 30 })).status).toBe(400); // must add up

    ({ batchId } = await makeBatch({ count: 150, premiumCount: 100 }));
    const rows = await q<{ username: string; is_test_account: boolean; email: string; is_guest: boolean }>(`SELECT username, is_test_account, email, is_guest FROM users WHERE beta_batch_id = $1 ORDER BY username`, [batchId]);
    expect(rows).toHaveLength(150);
    expect(rows[0]).toMatchObject({ username: 'beta001', email: `beta001@${DOMAIN}`, is_test_account: true, is_guest: false });
    expect(rows[149]!.username).toBe('beta150');
    expect(new Set(rows.map((r) => r.username)).size).toBe(150);
    expect((await q(`SELECT count(*)::int AS n FROM beta_grants`))[0]!.n).toBe(100);
    expect((await q(`SELECT count(*)::int AS n FROM beta_ops WHERE state = 'ready'`))[0]!.n).toBe(150);

    const hashes = await q<{ login: string; h: string }>(`SELECT u.username AS login, i.password_hash AS h FROM auth_identities i JOIN users u ON u.id = i.user_id WHERE u.beta_batch_id = $1 AND i.provider = 'email'`, [batchId]);
    expect(new Set(hashes.map((h) => h.h)).size).toBe(150); // different passwords → different hashes
    for (const login of ['beta001', 'beta002', 'beta003', 'beta100', 'beta150']) {
      const h = hashes.find((x) => x.login === login)!.h;
      expect(h.startsWith('$argon2id$')).toBe(true);
      expect(await argon2.verify(h, `${login}we`)).toBe(true);
      expect(await argon2.verify(h, login)).toBe(false);
    }
  }, 180_000);

  it('a tester signs in with the generated password; list and export never show passwords; credentials export is restricted', async () => {
    const r = await signIn('beta001');
    expect(r.status).toBe(200);
    expect(r.body.data.me.entitlement).toMatchObject({ active: true, source: 'beta' });
    expect((await signIn('beta001', 'beta002we')).status).toBe(401);
    expect((await signIn('beta150')).body.data.me.entitlement).toMatchObject({ active: false, source: 'none' }); // the free half

    const list = await A(editor).get('/v1/admin/beta/users?limit=5');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/beta00\dwe|password/i);
    expect(list.body.data[0]).toMatchObject({ login: 'beta001', state: 'active', provisioning: 'ready', access: { source: 'beta' } });
    const csv = await http(app).get('/v1/admin/beta/users/export', { token: owner });
    expect(csv.status).toBe(200);
    expect(String(csv.body)).not.toMatch(/beta001we|password/i);

    expect((await A(editor).get(`/v1/admin/beta/batches/${batchId}/credentials`)).status).toBe(403);
    const cred = await http(app).get(`/v1/admin/beta/batches/${batchId}/credentials`, { token: owner });
    expect(cred.status).toBe(200);
    expect(String(cred.body)).toContain(`beta001,beta001@${DOMAIN},beta001we`);
    expect(String(cred.body)).toContain(`beta150,beta150@${DOMAIN},beta150we`);
    expect(String(cred.headers['cache-control'])).toContain('no-store');
    expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'beta.credentials.export'`))[0]!.n).toBe(1);
    expect(JSON.stringify(await q(`SELECT before, after FROM audit_log`))).not.toMatch(/beta\d{3}we/);
  });

  it('a retry completes nothing twice and never resets a changed password', async () => {
    const id = await idOf('beta002');
    const reset = await act(id, 'reset_password');
    expect(reset.status).toBe(200);
    expect(reset.body.data.password).toMatch(/^[A-Za-z0-9]{14}$/);
    expect((await signIn('beta002')).status).toBe(401); // the generated password is gone
    expect((await signIn('beta002', reset.body.data.password)).status).toBe(200);
    const job = (await q<{ job_id: string }>(`SELECT job_id FROM beta_batches WHERE id = $1`, [batchId]))[0]!.job_id;
    await beta().runGenerate(job, batchId); // nothing is left to do
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE beta_batch_id = $1`, [batchId]))[0]!.n).toBe(150);
    expect((await signIn('beta002', reset.body.data.password)).status).toBe(200);
    expect((await signIn('beta002')).status).toBe(401);
    expect((await q(`SELECT count(*)::int AS n FROM beta_grants`))[0]!.n).toBe(100);
    const cred = await http(app).get(`/v1/admin/beta/batches/${batchId}/credentials`, { token: owner });
    expect(String(cred.body)).not.toContain('beta002,'); // a changed password is not exported as the initial one
  });

  it('a second batch continues the numbering and never reuses a login; member sign-up keeps its normal rules', async () => {
    const b2 = await makeBatch({ name: 'Beta Round 2', count: 3, prefix: 'beta', ...FREE });
    const logins = (await q<{ username: string }>(`SELECT username FROM users WHERE beta_batch_id = $1 ORDER BY username`, [b2.batchId])).map((r) => r.username);
    expect(logins).toEqual(['beta151', 'beta152', 'beta153']);
    const g = await guest(app);
    const weak = await http(app).post('/v1/auth/link/email', { email: 'member@example.test', password: 'beta1we' }, { token: g.accessToken });
    expect(weak.status).toBe(400); // still at least 8 characters for everybody else
    const m = await account(app);
    expect((await q(`SELECT is_test_account FROM users WHERE id = $1`, [m.me.id]))[0]!.is_test_account).toBe(false);
  }, 60_000);
});

describe('2–5, 9 · premium grant, removal, expiry, missed events', () => {
  it('a grant reaches every connected device of that user only, with no re-login', async () => {
    await makeBatch({ name: 'Grants', prefix: 'gran', count: 3, ...FREE });
    const s1 = await member('gran001'), s2 = await member('gran002');
    const id = s1.me.id;
    const premiumRoute = () => http(app).get(`/v1/daily-messages/${today()}`, { token: s1.accessToken });
    expect((await premiumRoute()).body.error?.code).toBe('PREMIUM_REQUIRED');

    const phone = track(await mustConnect(pod.url, '/live', { token: s1.accessToken })), tablet = track(await mustConnect(pod.url, '/live', { token: s1.accessToken }));
    const bystander = track(await mustConnect(pod.url, '/live', { token: s2.accessToken }));
    const r1 = recorder(phone, 'entitlement:changed'), r2 = recorder(tablet, 'entitlement:changed'), r3 = recorder(bystander, 'entitlement:changed');

    expect((await act(id, 'grant', { days: 7 })).status).toBe(200);
    const [e1] = await r1.wait('entitlement:changed');
    const [e2] = await r2.wait('entitlement:changed');
    expect(e1).toMatchObject({ active: true, source: 'beta' });
    expect(e1.betaExpiresAt).toBeTruthy();
    expect(e2.rev).toBe(e1.rev);
    await sleep(200);
    expect(r3.of('entitlement:changed')).toHaveLength(0); // nobody else hears about it
    expect(await ent().isActive(id)).toBe(true); // same token, no new login
    expect((await premiumRoute()).body.error?.code).not.toBe('PREMIUM_REQUIRED');
    expect((await http(app).get('/v1/me', { token: s1.accessToken })).body.data.entitlement).toMatchObject({ active: true, source: 'beta' });

    expect((await act(id, 'remove')).status).toBe(200);
    const [, e3] = await r1.wait('entitlement:changed', 2);
    expect(e3).toMatchObject({ active: false, source: 'none' });
    expect(e3.rev).toBeGreaterThan(e1.rev); // a client keeps the highest revision it has seen
    expect(await ent().isActive(id)).toBe(false);
    expect((await premiumRoute()).body.error?.code).toBe('PREMIUM_REQUIRED');
    r1.clear();
    await act(id, 'remove'); // removing twice changes nothing and sends nothing
    await sleep(250);
    expect(r1.of('entitlement:changed')).toHaveLength(0);
  });

  it('removing beta access keeps a genuine paid subscription', async () => {
    const id = await idOf('gran003');
    await q(`INSERT INTO entitlements (user_id, active, product_id, store, period_type, expires_at, will_renew) VALUES ($1, true, 'wehum_annual', 'app_store', 'normal', now() + interval '300 days', true)`, [id]);
    await act(id, 'grant', { days: 5 });
    expect((await ent().view(id)).source).toBe('paid+beta');
    const rm = await act(id, 'remove');
    expect(rm.body.data).toMatchObject({ active: true, source: 'paid', productId: 'wehum_annual' });
    expect(await ent().isActive(id)).toBe(true);
    expect((await q(`SELECT active FROM entitlements WHERE user_id = $1`, [id]))[0]!.active).toBe(true); // the paid row was never touched
    expect((await A(owner).get('/v1/admin/beta/users?q=gran003')).body.data[0].access.source).toBe('paid');
  });

  it('expiry is enforced by the server even when no event or webhook arrives, and announced once', async () => {
    const id = await idOf('gran001');
    await act(id, 'grant', { days: 1 });
    expect(await ent().isActive(id)).toBe(true); // primes the cache
    await q(`UPDATE beta_grants SET expires_at = now() + interval '2 seconds' WHERE user_id = $1`, [id]);
    await ent().invalidate(id);
    expect(await ent().isActive(id)).toBe(true);
    await sleep(2600);
    expect(await ent().isActive(id)).toBe(false); // the cached "yes" never outlives the expiry
    const s = await member('gran001');
    const phone = track(await mustConnect(pod.url, '/live', { token: s.accessToken }));
    const rec = recorder(phone, 'entitlement:changed');
    expect(await beta().expireDue()).toBeGreaterThanOrEqual(1);
    expect((await rec.wait('entitlement:changed'))[0]).toMatchObject({ active: false, source: 'none' });
    expect(await beta().expireDue()).toBe(0);
  });

  it('a webhook publishes the merged answer, so paid ending does not wipe beta access', async () => {
    const id = await idOf('gran002');
    await act(id, 'grant', { days: 10 });
    const s = await member('gran002');
    const phone = track(await mustConnect(pod.url, '/live', { token: s.accessToken }));
    const rec = recorder(phone, 'entitlement:changed');
    const eventId = uuid();
    const event = { id: eventId, type: 'EXPIRATION', app_user_id: id, original_app_user_id: id, aliases: [id], product_id: 'wehum_annual', store: 'APP_STORE', event_timestamp_ms: Date.now(), expiration_at_ms: Date.now() - 1000 };
    expect((await http(app).post('/webhooks/revenuecat', { api_version: '1.0', event }, { headers: { authorization: 'Bearer rc-test-secret' } })).status).toBe(200);
    await app.get(RcProcessor).process(eventId);
    expect((await rec.wait('entitlement:changed'))[0]).toMatchObject({ active: true, source: 'beta' });
  });

  it('a device that was offline during a change gets the current state from /me and the sync endpoint', async () => {
    const id = await idOf('gran002');
    const s = await member('gran002'); // signed in, then no socket at all
    await act(id, 'remove');
    const me = await http(app).get('/v1/me', { token: s.accessToken });
    expect(me.body.data.entitlement).toMatchObject({ active: false, source: 'none' });
    const sync = await http(app).post('/v1/me/entitlement/sync', {}, { token: s.accessToken });
    expect(sync.status).toBe(200);
    expect(sync.body.data).toMatchObject({ active: false, source: 'none' });
    await act(id, 'grant', { days: 3 });
    expect((await http(app).post('/v1/me/entitlement/sync', {}, { token: s.accessToken })).body.data).toMatchObject({ active: true, source: 'beta' });
  });
});

describe('6 · suspension', () => {
  it('ends every session, drops sockets, blocks login and refresh until resume, and resume revives nothing', async () => {
    await makeBatch({ name: 'Suspend', prefix: 'susp', count: 2, ...FREE });
    const first = await member('susp001'), second = await member('susp001'); // two devices
    const id = first.me.id;
    const phone = track(await mustConnect(pod.url, '/live', { token: first.accessToken }));
    const rec = recorder(phone, 'force:logout');
    let closed = false; phone.on('disconnect', () => { closed = true; });

    expect((await act(id, 'suspend', { reason: 'Round over' })).status).toBe(200);
    expect((await rec.wait('force:logout'))[0]).toEqual({ reason: 'account_suspended' });
    await waitFor(() => closed, 3000, 'socket dropped');

    expect((await http(app).get('/v1/me', { token: first.accessToken })).status).toBe(401);
    expect((await http(app).get('/v1/me', { token: second.accessToken })).status).toBe(401);
    const refused = await http(app).post('/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(refused.status).toBe(403); // an offline device is told why
    expect(refused.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await http(app).post('/v1/auth/refresh', { refreshToken: second.refreshToken })).status).toBe(403);
    const login = await signIn('susp001');
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await signIn('susp001', 'wrong-password-here')).status).toBe(401); // no hint without the right password
    const sock = await connect(pod.url, '/live', { token: first.accessToken });
    expect(sock.error?.code).toBeTruthy();
    sock.socket.close();
    expect((await A(owner).get('/v1/admin/beta/users?q=susp001')).body.data[0]).toMatchObject({ state: 'suspended', suspendedReason: 'Round over' });

    expect((await act(id, 'resume')).status).toBe(200);
    expect((await http(app).get('/v1/me', { token: first.accessToken })).status).toBe(401); // old sessions stay dead
    expect((await http(app).post('/v1/auth/refresh', { refreshToken: first.refreshToken })).status).toBe(401);
    expect((await signIn('susp001')).status).toBe(200);
  });

  it('a grant sent while an account is suspended cannot unlock it', async () => {
    const id = await idOf('susp002');
    await act(id, 'suspend', { reason: 'hold' });
    expect((await act(id, 'grant', { days: 5 })).status).toBe(200);
    expect(await ent().isActive(id)).toBe(false); // beta time is kept, access stays blocked
    expect((await ent().view(id)).active).toBe(false);
    await act(id, 'resume');
    expect(await ent().isActive(id)).toBe(true);
  });

  it('a socket that is still open loses its session on its next event, even if force:logout never arrived', async () => {
    const id = await idOf('susp001');
    const s = await member('susp001');
    const phone = track(await mustConnect(pod.url, '/live', { token: s.accessToken }));
    await q(`UPDATE users SET suspended_at = now(), token_version = token_version + 1 WHERE id = $1`, [id]); // changed behind the sockets' back
    await app.get<import('ioredis').default>(REDIS).del(`tv:${id}`);
    let closed = false; phone.on('disconnect', () => { closed = true; });
    phone.emit('time:sync', { t0: Date.now() });
    await waitFor(() => closed, 3000, 'stale socket closed');
  });
});

describe('7–8 · deletion', () => {
  it('shows the exact scope, protects members and paying testers, blocks access first, reports per account, retries, and a late webhook cannot bring one back', async () => {
    const { batchId } = await makeBatch({ name: 'Round to delete', prefix: 'dele', count: 4, ...FREE });
    const ids = await Promise.all(['dele001', 'dele002', 'dele003', 'dele004'].map(idOf));
    const regular = await account(app);
    // a regular member id is not reachable from the beta section
    expect((await A(owner).post('/v1/admin/beta/bulk', { action: 'suspend', selection: { ids: [ids[0], regular.me.id] } })).status).toBe(400);
    expect((await act(regular.me.id, 'suspend')).status).toBe(404);
    expect((await A(owner).get(`/v1/admin/beta/users?q=${regular.me.id}`)).body.data).toHaveLength(0);
    expect((await http(app).request('DELETE', `/v1/admin/users/${ids[0]}`, { token: owner, body: { confirm: `dele001@${DOMAIN}` } })).status).toBe(422); // the regular route refuses test accounts

    await q(`INSERT INTO entitlements (user_id, active, product_id, store, period_type, expires_at, will_renew) VALUES ($1, true, 'wehum_annual', 'app_store', 'normal', now() + interval '200 days', true)`, [ids[3]]);
    const review = await A(owner).post('/v1/admin/beta/bulk/review', { selection: { all: true, filter: { batchId } } });
    expect(review.body.data).toMatchObject({ count: 3, selected: 4, phrase: 'DELETE Round to delete', groups: [{ name: 'Round to delete', count: 3 }] });
    expect(review.body.data.blocked).toEqual([expect.objectContaining({ login: 'dele004' })]);

    const s1 = await member('dele001');
    await member('dele002');
    const phone = track(await mustConnect(pod.url, '/live', { token: s1.accessToken }));
    const rec = recorder(phone, 'force:logout');

    const sel = { all: true, filter: { batchId } };
    expect((await A(owner).post('/v1/admin/beta/bulk', { action: 'delete', selection: sel, params: { confirm: 'delete round to delete' } })).status).toBe(400); // exact phrase
    expect((await A(editor).post('/v1/admin/beta/bulk', { action: 'delete', selection: sel, params: { confirm: 'DELETE Round to delete' } })).status).toBe(403);
    expect((await A(owner).post('/v1/admin/beta/bulk', { action: 'delete', selection: sel, expectedCount: 9, params: { confirm: 'DELETE Round to delete' } })).status).toBe(422); // the selection moved

    const go = await A(owner).post('/v1/admin/beta/bulk', { action: 'delete', selection: sel, expectedCount: 4, params: { confirm: 'DELETE Round to delete' } });
    expect(go.status).toBe(202);
    expect(go.body.data.count).toBe(3);
    expect(go.body.data.skipped).toEqual([expect.objectContaining({ login: 'dele004' })]);
    const jobId = go.body.data.jobId as string;

    // access is blocked before the cleanup job has even started
    expect((await rec.wait('force:logout'))[0]).toEqual({ reason: 'account_deleted' });
    expect((await q(`SELECT username FROM users WHERE deleting_at IS NOT NULL ORDER BY username`)).map((r) => r.username)).toEqual(['dele001', 'dele002', 'dele003']);
    expect((await signIn('dele001')).status).toBe(401);
    expect((await http(app).get('/v1/me', { token: s1.accessToken })).status).toBe(401);
    expect((await http(app).post('/v1/auth/refresh', { refreshToken: s1.refreshToken })).status).toBe(401);
    expect((await signIn('dele004')).status).toBe(200); // the protected one is untouched
    expect(await ent().isActive(ids[0]!)).toBe(false);
    expect((await A(owner).get('/v1/admin/beta/users?state=deleting')).body.data.map((r: { login: string }) => r.login)).toEqual(['dele001', 'dele002', 'dele003']);
    // no new grant can re-enable a deleting account
    expect((await act(ids[0]!, 'grant', { days: 5 })).status).toBe(422);

    // first attempt: cleanup of one account fails; it stays blocked and is reported
    const data = app.get(UserDataService);
    const real = data.deleteUser.bind(data);
    const spy = vi.spyOn(data, 'deleteUser').mockImplementation(async (j, uid, admin, opts) => {
      if (uid === ids[1]) throw new Error('storage unavailable');
      return real(j, uid, admin, opts);
    });
    await beta().runBulk(jobId);
    let job = (await A(owner).get(`/v1/admin/beta/jobs/${jobId}`)).body.data;
    expect(job).toMatchObject({ status: 'failed', ok: 2, failed: 1, total: 3 });
    expect(job.failures).toEqual([expect.objectContaining({ login: 'dele002', error: 'storage unavailable' })]);
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE username = ANY('{dele001,dele003}')`))[0]!.n).toBe(0);
    expect((await q(`SELECT deleting_at IS NOT NULL AS blocked FROM users WHERE username = 'dele002'`))[0]!.blocked).toBe(true); // still blocked
    expect((await q(`SELECT step, error FROM beta_deletions WHERE user_id = $1`, [ids[1]]))[0]).toMatchObject({ step: 'failed', error: 'storage unavailable' });

    // retry only the failed one; nothing already done runs again
    spy.mockRestore();
    const calls = vi.spyOn(data, 'deleteUser');
    expect((await A(owner).post(`/v1/admin/beta/jobs/${jobId}/retry`)).status).toBe(202);
    await beta().runBulk(jobId);
    expect(calls).toHaveBeenCalledTimes(1);
    calls.mockRestore();
    job = (await A(owner).get(`/v1/admin/beta/jobs/${jobId}`)).body.data;
    expect(job).toMatchObject({ status: 'done', ok: 3, failed: 0 });
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE username LIKE 'dele%'`))[0]!.n).toBe(1); // only dele004 is left
    expect((await q(`SELECT step FROM beta_deletions ORDER BY user_id`)).every((r) => r.step === 'done')).toBe(true);
    expect((await q(`SELECT count(*)::int AS n FROM deleted_identities WHERE login LIKE 'dele%'`))[0]!.n).toBe(3);
    expect((await A(owner).get('/v1/admin/beta/users?state=deleting')).body.data).toHaveLength(0);

    // a late RevenueCat event for a deleted account neither recreates it nor grants anything
    const eventId = uuid();
    const event = { id: eventId, type: 'INITIAL_PURCHASE', app_user_id: ids[0], original_app_user_id: ids[0], aliases: [ids[0]], product_id: 'wehum_annual', period_type: 'NORMAL', store: 'APP_STORE', event_timestamp_ms: Date.now(), purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 86_400_000 * 365, price: 79, currency: 'USD' };
    expect((await http(app).post('/webhooks/revenuecat', { api_version: '1.0', event }, { headers: { authorization: 'Bearer rc-test-secret' } })).status).toBe(200);
    await app.get(RcProcessor).process(eventId);
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [ids[0]]))[0]!.n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM entitlements WHERE user_id = $1`, [ids[0]]))[0]!.n).toBe(0);
    await expect(app.get(RcProcessor).syncUser(ids[0]!)).rejects.toMatchObject({ code: 'GONE' });

    // a deleted login is never handed out again
    const next = await makeBatch({ name: 'After delete', prefix: 'dele', count: 1, ...FREE });
    expect((await q(`SELECT username FROM users WHERE beta_batch_id = $1`, [next.batchId]))[0]!.username).toBe('dele005');
  }, 120_000);
});

describe('11 · sample data', () => {
  it('Light preset adds labelled fixtures; reset removes only those and keeps genuine activity; reports do not count them', async () => {
    const { batchId } = await makeBatch({ name: 'Light sample', prefix: 'samp', count: 2, seedPreset: 'light', ...FREE });
    const id = await idOf('samp001');
    const before = await beta().samplePreview(id);
    expect(before.total).toBeGreaterThan(0);
    expect((await q(`SELECT first_name, bio FROM users WHERE id = $1`, [id]))[0]).toMatchObject({ first_name: 'Alex Rivers' });
    expect((await q(`SELECT count(*)::int AS n FROM meditations WHERE user_id = $1 AND counted = false`, [id]))[0]!.n).toBeGreaterThanOrEqual(0);
    // the tester does something real
    const sess = (await q<{ id: string }>(`SELECT id FROM sessions LIMIT 1`))[0]?.id ?? null;
    const genuine = uuid();
    await q(`INSERT INTO meditations (id, user_id, session_id, kind, started_at, ended_at, duration_sec, counted, completed, local_date) VALUES ($1,$2,$3,'solo', now(), now(), 600, true, true, current_date)`, [genuine, id, sess]);
    const seededSits = (await q(`SELECT count(*)::int AS n FROM seed_fixtures WHERE user_id = $1 AND kind = 'sit' AND ref_id <> 'none'`, [id]))[0]!.n;

    const r = await act(id, 'reset_sample');
    expect(r.status).toBe(200);
    expect((await beta().samplePreview(id)).total).toBe(0);
    expect((await q(`SELECT first_name, bio FROM users WHERE id = $1`, [id]))[0]).toMatchObject({ first_name: null, bio: null });
    expect((await q(`SELECT count(*)::int AS n FROM meditations WHERE id = $1`, [genuine]))[0]!.n).toBe(1); // genuine activity stays
    expect((await q(`SELECT count(*)::int AS n FROM meditations WHERE user_id = $1`, [id]))[0]!.n).toBe(1);
    expect(seededSits).toBeGreaterThanOrEqual(0);
    // seeding never sends anything or touches payments
    expect((await q(`SELECT count(*)::int AS n FROM push_log WHERE user_id IN (SELECT id FROM users WHERE beta_batch_id = $1)`, [batchId]))[0]!.n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM subscription_events WHERE user_id IN (SELECT id FROM users WHERE beta_batch_id = $1)`, [batchId]))[0]!.n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM entitlements WHERE user_id IN (SELECT id FROM users WHERE beta_batch_id = $1)`, [batchId]))[0]!.n).toBe(0);

    // normal acquisition and usage numbers leave test accounts out
    await app.get(AnalyticsService).rollup(today());
    const agg = (await q(`SELECT new_users, meditations FROM daily_aggregates WHERE date = $1`, [today()]))[0]!;
    expect(agg.new_users).toBe((await q(`SELECT count(*)::int AS n FROM users WHERE NOT is_test_account AND created_at::date = current_date`))[0]!.n);
    expect(agg.meditations).toBe((await q(`SELECT count(*)::int AS n FROM meditations m JOIN users u ON u.id = m.user_id WHERE m.counted AND NOT u.is_test_account AND m.started_at::date = current_date`))[0]!.n);
    // the normal Users list leaves them out too
    const users = await A(owner).get('/v1/admin/users?tab=all&limit=100');
    expect(JSON.stringify(users.body.data)).not.toContain(`@${DOMAIN}`);
    expect(users.body.meta.counts.all).toBe((await q(`SELECT count(*)::int AS n FROM users WHERE NOT is_test_account AND deleted_at IS NULL`))[0]!.n);
  });
});

describe('12 · roles and scope', () => {
  it('read-only roles cannot write; every write needs owner or admin; unknown ids and members look the same', async () => {
    const id = await idOf('samp002');
    expect((await A(editor).get('/v1/admin/beta/summary')).status).toBe(200);
    expect((await A(editor).get('/v1/admin/beta/users')).status).toBe(200);
    expect((await A(moderator).get('/v1/admin/beta/users')).status).toBe(403);
    expect((await http(app).get('/v1/admin/beta/users')).status).toBe(401);
    for (const [path, body] of [
      [`/v1/admin/beta/users/${id}/action`, { action: 'suspend', params: {} }],
      ['/v1/admin/beta/bulk', { action: 'remove', selection: { ids: [id] } }],
      ['/v1/admin/beta/batches', { name: 'Nope', count: 2, prefix: 'nope', access: 'free' }],
      ['/v1/admin/beta/import', { csv: 'login,display_name,access,premium_days\nnope001,,free,\n' }],
    ] as const) {
      expect((await A(editor).post(path, body)).status).toBe(403);
      expect((await A(moderator).post(path, body)).status).toBe(403);
    }
    expect((await q(`SELECT suspended_at FROM users WHERE id = $1`, [id]))[0]!.suspended_at).toBeNull();
    expect((await act(uuid(), 'suspend')).status).toBe(404);
    const summary = (await A(owner).get('/v1/admin/beta/summary')).body.data;
    expect(summary.total).toBeGreaterThan(100);
    expect(summary.total).toBe((await q(`SELECT count(*)::int AS n FROM users WHERE is_test_account AND deleted_at IS NULL`))[0]!.n);
  });

  it('CSV import previews errors, rejects duplicates and existing logins, and never converts a member', async () => {
    const csv = 'login,display_name,access,premium_days\nimpa001,Ann,free,\nimpa001,Dup,free,\nbeta001,Taken,free,\nimpa003,Pat,premium,14\nXY,Bad,free,\n';
    const pre = await A(owner).post('/v1/admin/beta/import/preview', { csv });
    expect(pre.body.data).toMatchObject({ valid: 2, invalid: 3 });
    expect((await A(owner).post('/v1/admin/beta/import', { csv })).status).toBe(400); // errors block the import unless skipped
    const imp = await A(owner).post('/v1/admin/beta/import', { csv, skipInvalid: true, name: 'Imported' });
    expect(imp.status).toBe(202);
    await beta().runGenerate(imp.body.data.jobId, imp.body.data.batchId);
    expect((await q(`SELECT username, is_test_account FROM users WHERE beta_batch_id = $1 ORDER BY username`, [imp.body.data.batchId]))).toEqual([{ username: 'impa001', is_test_account: true }, { username: 'impa003', is_test_account: true }]);
    expect((await member('impa003')).me.entitlement).toMatchObject({ active: true, source: 'beta' });
    expect((await A(editor).get('/v1/admin/beta/import/template')).status).toBe(200);
  });
});
