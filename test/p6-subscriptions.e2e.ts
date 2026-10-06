import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RealtimeBus } from '../src/infra/realtime-bus';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { RcProcessor } from '../src/modules/subscriptions/rc.processor';
import { RevenueCatClient } from '../src/modules/subscriptions/revenuecat.client';
import { adminToken, bootApp, guest, http, makeAdmin, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let owner: string, editor: string, adminTok: string, mod: string;
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const H = { authorization: 'Bearer rc-test-secret' };

const DAY = 86_400_000;
let clock = Date.now();
const tick = () => (clock += 1000);

/** A RevenueCat webhook body like the real ones (fields we use). */
function ev(type: string, userId: string, over: Record<string, unknown> = {}) {
  return {
    api_version: '1.0',
    event: {
      id: uuid(), type, app_user_id: userId, original_app_user_id: userId, aliases: [userId], product_id: 'wehum_annual', period_type: 'NORMAL', store: 'APP_STORE',
      event_timestamp_ms: tick(), purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 365 * DAY, price: 79, currency: 'USD', ...over,
    },
  };
}
async function send(body: ReturnType<typeof ev>, headers: Record<string, string> = H) {
  const r = await http(app).post('/webhooks/revenuecat', body, { headers });
  if (r.status === 200) await app.get(RcProcessor).process(body.event.id); // the worker does this in production
  return r;
}
const ent = async (id: string) => (await q<Record<string, any>>(`SELECT * FROM entitlements WHERE user_id=$1`, [id]))[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
const founding = async () => (await q<{ taken: number; open: boolean; cap: number }>(`SELECT taken, open, cap FROM offers WHERE id='founding'`))[0]!;
const newUser = async () => (await guest(app)).me.id as string;

const rcCalls: { url: string; method: string; body?: unknown }[] = [];
let subscriber: Record<string, unknown> | null = null;
beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  owner = await adminToken(app, await makeAdmin(db, 'owner')); editor = await adminToken(app, await makeAdmin(db, 'editor'));
  adminTok = await adminToken(app, await makeAdmin(db, 'admin')); mod = await adminToken(app, await makeAdmin(db, 'moderator'));
  app.get(RevenueCatClient).fetchImpl = (async (url: string, init?: RequestInit) => {
    rcCalls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (subscriber === null && init?.method === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(init?.method ? {} : { subscriber }), { status: 200 });
  }) as typeof fetch;
});
afterAll(async () => { await db?.end(); await app?.close(); });
beforeEach(() => { rcCalls.length = 0; subscriber = null; });

describe('P6 webhook', () => {
  it('needs the secret', async () => {
    const u = await newUser();
    expect((await http(app).post('/webhooks/revenuecat', ev('INITIAL_PURCHASE', u), { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await http(app).post('/webhooks/revenuecat', ev('INITIAL_PURCHASE', u), {})).status).toBe(401);
    expect((await http(app).post('/webhooks/revenuecat', { nope: true }, { headers: H })).status).toBe(400);
  });

  it('trial → paid → cancelled (still has access) → billing issue → expired; each step is on the entitlement and announced', async () => {
    const u = await newUser();
    const seen: { topic: string; payload: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    await app.get(RealtimeBus).subscribe((e) => seen.push(e as never));
    const ents = app.get(EntitlementService);

    expect((await send(ev('INITIAL_PURCHASE', u, { period_type: 'TRIAL', expiration_at_ms: Date.now() + 7 * DAY, price: 0 }))).status).toBe(200);
    expect(await ent(u)).toMatchObject({ active: true, period_type: 'trial', product_id: 'wehum_annual', will_renew: true, is_founding: false, store: 'app_store' });
    expect(await ents.isActive(u)).toBe(true);

    await send(ev('RENEWAL', u, { period_type: 'NORMAL' }));
    expect(await ent(u)).toMatchObject({ active: true, period_type: 'normal' });
    await send(ev('CANCELLATION', u));
    expect(await ent(u)).toMatchObject({ active: true, will_renew: false }); // paid until the period ends
    await send(ev('BILLING_ISSUE', u));
    expect(await ent(u)).toMatchObject({ billing_issue: true, active: true });
    await send(ev('UNCANCELLATION', u));
    expect(await ent(u)).toMatchObject({ will_renew: true, billing_issue: false });
    await send(ev('EXPIRATION', u, { expiration_at_ms: Date.now() - 1000 }));
    expect(await ent(u)).toMatchObject({ active: false, will_renew: false });
    expect(await ents.isActive(u)).toBe(false); // the 60 s cache was busted

    await new Promise((r) => setTimeout(r, 300));
    const changed = seen.filter((s) => s.topic === 'entitlement:changed' && s.payload.userId === u);
    expect(changed.length).toBe(6);
    expect(changed.at(-1)!.payload.entitlement).toMatchObject({ active: false });
    expect(seen.filter((s) => s.topic === 'subs:event' && s.payload.event.userId === u)).toHaveLength(6);
    expect((await q(`SELECT 1 FROM subscription_events WHERE user_id=$1`, [u])).length).toBe(6);
  });

  it('the same event twice is stored and counted once; out-of-order events are kept but not applied', async () => {
    const u = await newUser();
    const first = ev('INITIAL_PURCHASE', u, { product_id: 'wehum_annual_founding', price: 59 });
    const before = (await founding()).taken;
    expect((await send(first)).body.data.duplicate).toBe(false);
    expect((await http(app).post('/webhooks/revenuecat', first, { headers: H })).body.data.duplicate).toBe(true);
    expect(await app.get(RcProcessor).process(first.event.id)).toBe('duplicate');
    expect((await founding()).taken).toBe(before + 1);
    expect(await ent(u)).toMatchObject({ is_founding: true });

    const newer = ev('RENEWAL', u, { product_id: 'wehum_annual_founding' });
    const older = ev('EXPIRATION', u, { product_id: 'wehum_annual_founding', event_timestamp_ms: newer.event.event_timestamp_ms - 5000, expiration_at_ms: Date.now() - 1000 });
    await send(newer);
    await send(older); // arrives late
    expect(await ent(u)).toMatchObject({ active: true });
    expect((await q(`SELECT 1 FROM subscription_events WHERE id=$1`, [older.event.id])).length).toBe(1);
  });

  it('a purchase that arrives before the app made the guest creates the user; anonymous RevenueCat ids are kept only in the log', async () => {
    const id = uuid();
    await send(ev('INITIAL_PURCHASE', id));
    expect((await q(`SELECT 1 FROM users WHERE id=$1`, [id])).length).toBe(1);
    expect(await ent(id)).toMatchObject({ active: true });
    const anon = ev('INITIAL_PURCHASE', '$RCAnonymousID:abc', { aliases: ['$RCAnonymousID:abc'] });
    expect((await send(anon)).status).toBe(200);
    expect((await q(`SELECT user_id FROM subscription_events WHERE id=$1`, [anon.event.id]))[0]).toMatchObject({ user_id: null });
  });

  it('TRANSFER moves the access to the other account (re-read from RevenueCat)', async () => {
    const [from, to] = [await newUser(), await newUser()];
    await send(ev('INITIAL_PURCHASE', from));
    expect((await ent(from))!.active).toBe(true);
    subscriber = { entitlements: { premium: { product_identifier: 'wehum_annual', expires_date: new Date(Date.now() + 100 * DAY).toISOString(), purchase_date: new Date().toISOString() } }, subscriptions: { wehum_annual: { period_type: 'normal', store: 'app_store' } } };
    await send(ev('TRANSFER', from, { transferred_from: [from], transferred_to: [to] }));
    expect((await ent(from))!.active).toBe(false);
    expect(await ent(to)).toMatchObject({ active: true, product_id: 'wehum_annual', period_type: 'normal' });
  });

  it('founding cap: the last slot closes the offer and switches the RevenueCat offering once', async () => {
    await q(`UPDATE offers SET cap = taken + 2, open = true, closed_at = NULL WHERE id='founding'`);
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    await send(ev('INITIAL_PURCHASE', a, { product_id: 'wehum_annual_founding', price: 59 }));
    expect((await founding()).open).toBe(true);
    expect(rcCalls).toHaveLength(0);
    await send(ev('INITIAL_PURCHASE', b, { product_id: 'wehum_annual_founding', price: 59 }));
    expect((await founding()).open).toBe(false);
    expect(rcCalls.filter((c) => c.url.includes('/offerings/regular'))).toHaveLength(1);
    expect(rcCalls[0]).toMatchObject({ method: 'POST', body: { is_current: true } });
    await send(ev('INITIAL_PURCHASE', c, { product_id: 'wehum_annual_founding', price: 59 })); // overshoot is accepted
    expect((await founding()).taken).toBeGreaterThanOrEqual((await founding()).cap);
    expect(rcCalls.filter((x) => x.url.includes('/offerings/regular'))).toHaveLength(1); // not switched again
  });
});

describe('P6 sync + reconcile', () => {
  it('POST /v1/me/entitlement/sync reads RevenueCat and unlocks at once', async () => {
    const g = await guest(app);
    subscriber = { entitlements: { premium: { product_identifier: 'wehum_monthly', expires_date: new Date(Date.now() + 20 * DAY).toISOString(), purchase_date: new Date().toISOString() } }, subscriptions: { wehum_monthly: { period_type: 'trial', store: 'play_store', billing_issues_detected_at: null } } };
    const r = await http(app).post('/v1/me/entitlement/sync', {}, { token: g.accessToken });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ active: true, productId: 'wehum_monthly', periodType: 'trial' });
    expect(await app.get(EntitlementService).isActive(g.me.id)).toBe(true);
    expect((await http(app).post('/v1/me/entitlement/sync', {})).status).toBe(401);
  });

  it('reconcile re-reads members whose entitlement is more than a day old', async () => {
    const u = await newUser();
    await send(ev('INITIAL_PURCHASE', u));
    subscriber = { entitlements: {}, subscriptions: {} }; // RevenueCat says: no access any more
    await q(`UPDATE entitlements SET updated_at = now() - interval '2 days' WHERE user_id=$1`, [u]);
    expect(await app.get(RcProcessor).reconcile()).toBeGreaterThanOrEqual(1);
    expect((await ent(u))!.active).toBe(false);
  });
});

describe('P6 admin APIs', () => {
  it('summary: counts, MRR from RevenueCat prices, founding counter, plans', async () => {
    const [m, a, t] = [await newUser(), await newUser(), await newUser()];
    await send(ev('INITIAL_PURCHASE', m, { product_id: 'wehum_monthly', price: 9.99, expiration_at_ms: Date.now() + 30 * DAY }));
    await send(ev('INITIAL_PURCHASE', t, { product_id: 'wehum_annual', period_type: 'TRIAL', price: 0, expiration_at_ms: Date.now() + 7 * DAY }));
    await send(ev('INITIAL_PURCHASE', a, { product_id: 'wehum_annual', price: 79 }));
    const s = (await http(app).get('/v1/admin/subscriptions/summary', { token: editor })).body.data;
    expect(s.payingMembers.monthly).toBeGreaterThanOrEqual(1);
    expect(s.payingMembers.total).toBe(s.payingMembers.founding + s.payingMembers.annual + s.payingMembers.monthly);
    expect(s.inTrial).toBeGreaterThanOrEqual(1);
    expect(s.mrrUsd).toBeGreaterThan(0);
    expect(s.founding).toMatchObject({ cap: expect.any(Number), left: expect.any(Number) });
    expect(s.plans.find((p: { productId: string }) => p.productId === 'wehum_monthly')).toMatchObject({ priceUsd: 9.99, trialDays: 7 });
    expect((await http(app).get('/v1/admin/subscriptions/summary', { token: mod })).status).toBe(403);
  });

  it('members: tabs and cursor pages; events feed newest first', async () => {
    const all = (await http(app).get('/v1/admin/subscriptions/members?limit=2', { token: owner })).body;
    expect(all.data).toHaveLength(2);
    expect(all.meta.nextCursor).toBeTruthy();
    const next = (await http(app).get(`/v1/admin/subscriptions/members?limit=2&cursor=${all.meta.nextCursor}`, { token: owner })).body;
    expect(next.data.every((r: { userId: string }) => !all.data.some((x: { userId: string }) => x.userId === r.userId))).toBe(true);
    const trial = (await http(app).get('/v1/admin/subscriptions/members?tab=trial', { token: owner })).body.data;
    expect(trial.length).toBeGreaterThan(0);
    expect(trial.every((r: { periodType: string }) => r.periodType === 'trial')).toBe(true);
    const monthly = (await http(app).get('/v1/admin/subscriptions/members?tab=monthly', { token: owner })).body.data;
    expect(monthly.every((r: { productId: string }) => /monthly/.test(r.productId))).toBe(true);
    const events = (await http(app).get('/v1/admin/subscriptions/events?limit=5', { token: editor })).body;
    const times = events.data.map((e: { eventAt: string }) => Date.parse(e.eventAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect((await http(app).get('/v1/admin/subscriptions/members?tab=bogus', { token: owner })).status).toBe(400);
  });

  it('gift: owner/admin only; RevenueCat is called, the entitlement is promotional, the action is audited', async () => {
    const u = await newUser();
    subscriber = { entitlements: { premium: { product_identifier: 'wehum_monthly', expires_date: new Date(Date.now() + 30 * DAY).toISOString(), purchase_date: new Date().toISOString() } }, subscriptions: { wehum_monthly: { period_type: 'promotional', store: 'promotional' } } };
    expect((await http(app).post(`/v1/admin/users/${u}/gift`, { days: 30 }, { token: editor })).status).toBe(403);
    expect((await http(app).post(`/v1/admin/users/${u}/gift`, { days: 0 }, { token: adminTok })).status).toBe(400);
    expect((await http(app).post(`/v1/admin/users/${uuid()}/gift`, { days: 30 }, { token: adminTok })).status).toBe(404);
    const r = await http(app).post(`/v1/admin/users/${u}/gift`, { days: 30 }, { token: adminTok });
    expect(r.status).toBe(200);
    expect(r.body.data.active).toBe(true);
    expect(rcCalls.find((c) => c.url.includes('/promotional'))).toMatchObject({ method: 'POST' });
    expect(await ent(u)).toMatchObject({ active: true, store: 'promotional' });
    expect((await q(`SELECT 1 FROM audit_log WHERE action='user.gift' AND target_id=$1`, [u])).length).toBe(1);
  });

  it('end the Founding offer: owner/admin only, once, audited, offering switched', async () => {
    await q(`UPDATE offers SET open = true, closed_at = NULL WHERE id='founding'`);
    expect((await http(app).post('/v1/admin/offers/founding/close', {}, { token: editor })).status).toBe(403);
    const r = await http(app).post('/v1/admin/offers/founding/close', {}, { token: owner });
    expect(r.status).toBe(200);
    expect(r.body.data.open).toBe(false);
    expect(rcCalls.filter((c) => c.url.includes('/offerings/regular'))).toHaveLength(1);
    expect((await http(app).post('/v1/admin/offers/founding/close', {}, { token: owner })).body.error.code).toBe('INVALID_STATE');
    expect((await q(`SELECT 1 FROM audit_log WHERE action='offer.close'`)).length).toBe(1);
  });
});
