import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RealtimeBus } from '../src/infra/realtime-bus';
import { inQuietHours, localClock, PushService } from '../src/modules/push/push.service';
import { PushTransport, type PushMessage } from '../src/modules/push/push.transport';
import { adminToken, bootApp, guest, http, makeAdmin, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let owner: string, editor: string, adminTok: string, mod: string;
const q = async <T = Record<string, any>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const bus: { topic: string; payload: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let sent: PushMessage[] = [];
const A = (t: string) => ({
  get: (u: string) => http(app).get(u, { token: t }), post: (u: string, b: unknown = {}) => http(app).post(u, b, { token: t }),
  patch: (u: string, b: unknown = {}) => http(app).patch(u, b, { token: t }),
});
const push = () => app.get(PushService);
const HOUR = 3_600_000;

/** A person with a phone: guest + device with a push token, in a time zone, with a reminder time. */
async function phone(o: { tz?: string; reminder?: string; name?: string; country?: string; token?: string; enabled?: boolean } = {}) {
  const g = await guest(app);
  const token = o.token ?? `tok-${uuid()}`;
  await http(app).post('/v1/me/devices', { installId: g.installId, platform: 'ios', pushToken: token, appVersion: '1.0.0' }, { token: g.accessToken });
  await q(`UPDATE users SET timezone=$2, reminder_time=$3, first_name=$4, country=$5, reminder_enabled=$6 WHERE id=$1`, [g.me.id, o.tz ?? 'UTC', o.reminder ?? '07:00', o.name ?? 'Sam', o.country ?? 'ZZ', o.enabled ?? true]);
  return { id: g.me.id, token, access: g.accessToken, installId: g.installId };
}
const to = (p: { token: string }) => sent.filter((m) => m.token === p.token);

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const a = await Promise.all((['owner', 'editor', 'admin', 'moderator'] as const).map((r) => makeAdmin(db, r)));
  [owner, editor, adminTok, mod] = (await Promise.all(a.map((x) => adminToken(app, x)))) as [string, string, string, string];
  await app.get(RealtimeBus).subscribe((e) => bus.push(e as never));
  app.get(PushTransport).impl = async (msgs) => { sent.push(...msgs); return msgs.map((m) => ({ token: m.token, status: m.token.startsWith('bad') ? 'invalid' as const : m.token.startsWith('fail') ? 'failed' as const : 'ok' as const })); };
});
afterAll(async () => { await db?.end(); await app?.close(); });
beforeEach(() => { sent = []; });

describe('P8 local clock', () => {
  it('five zones, half-hour offsets and the DST changeover days', () => {
    const at = Date.parse('2026-10-05T04:30:00Z');
    expect(localClock(at, 'UTC')).toEqual({ date: '2026-10-05', hhmm: '04:30' });
    expect(localClock(at, 'Europe/Berlin').hhmm).toBe('06:30');
    expect(localClock(at, 'America/New_York')).toEqual({ date: '2026-10-05', hhmm: '00:30' });
    expect(localClock(at, 'Asia/Karachi').hhmm).toBe('09:30');
    expect(localClock(at, 'Australia/Sydney').hhmm).toBe('15:30');
    expect(localClock(at, 'Asia/Kolkata').hhmm).toBe('10:00');
    expect(localClock(Date.parse('2026-10-25T00:30:00Z'), 'Europe/Berlin').hhmm).toBe('02:30'); // CEST
    expect(localClock(Date.parse('2026-10-25T01:30:00Z'), 'Europe/Berlin').hhmm).toBe('02:30'); // the hour repeats: CET
    expect(localClock(Date.parse('2026-03-29T00:59:00Z'), 'Europe/Berlin').hhmm).toBe('01:59'); // spring forward: 02:xx does not exist
    expect(localClock(Date.parse('2026-03-29T01:00:00Z'), 'Europe/Berlin').hhmm).toBe('03:00');
    expect(localClock(Date.parse('2026-10-04T14:00:00Z'), 'Pacific/Auckland')).toEqual({ date: '2026-10-05', hhmm: '03:00' });
  });
  it('quiet hours are 22:00 to 07:00', () => {
    for (const t of ['22:00', '23:59', '00:00', '06:59']) expect(inQuietHours(t), t).toBe(true);
    for (const t of ['07:00', '12:00', '21:59']) expect(inQuietHours(t), t).toBe(false);
  });
});

describe('P8 devices and inbox', () => {
  it('register, move a token to the newest phone, clear it', async () => {
    const a = await guest(app), b = await guest(app);
    const body = (g: { installId: string }, tok: string | null) => ({ installId: g.installId, platform: 'android', pushToken: tok, appVersion: '2.1.0', model: 'Pixel' });
    const r1 = await http(app).post('/v1/me/devices', body(a, 'shared-token-abc123'), { token: a.accessToken });
    expect(r1.status).toBe(201);
    expect(r1.body.data).toMatchObject({ pushEnabled: true });
    await http(app).post('/v1/me/devices', body(b, 'shared-token-abc123'), { token: b.accessToken });
    expect((await q(`SELECT push_token FROM devices WHERE install_id=$1`, [a.installId]))[0]!.push_token).toBeNull(); // one token, one phone
    expect((await q(`SELECT push_token FROM devices WHERE install_id=$1`, [b.installId]))[0]!.push_token).toBe('shared-token-abc123');
    expect((await http(app).post('/v1/me/devices', { installId: 'x' }, { token: a.accessToken })).status).toBe(400);
    expect((await http(app).post('/v1/me/devices', body(b, 'x'), {})).status).toBe(401);
    const devId = (await q(`SELECT id FROM devices WHERE install_id=$1`, [b.installId]))[0]!.id;
    expect((await http(app).del(`/v1/me/devices/${devId}`, { token: a.accessToken })).status).toBe(404); // not yours
    expect((await http(app).del(`/v1/me/devices/${devId}`, { token: b.accessToken })).status).toBe(204);
    expect((await q(`SELECT push_token FROM devices WHERE id=$1`, [devId]))[0]!.push_token).toBeNull();
  });

  it('inbox: newest first, cursor, unread count, mark some or all as read', async () => {
    const p = await phone();
    for (let i = 0; i < 5; i++) await q(`INSERT INTO inbox_items (id, user_id, type, title, body, created_at) VALUES ($1,$2,'announcement',$3,'b', now() - ($4 || ' minutes')::interval)`, [uuid(), p.id, `Item ${i}`, String(i)]);
    const first = (await http(app).get('/v1/me/inbox?limit=2', { token: p.access })).body;
    expect(first.data.map((d: { title: string }) => d.title)).toEqual(['Item 0', 'Item 1']);
    expect(first.meta.unread).toBe(5);
    const next = (await http(app).get(`/v1/me/inbox?limit=10&cursor=${first.meta.nextCursor}`, { token: p.access })).body;
    expect(next.data.map((d: { title: string }) => d.title)).toEqual(['Item 2', 'Item 3', 'Item 4']);
    expect((await http(app).post('/v1/me/inbox/read', { ids: [first.data[0].id] }, { token: p.access })).body.data.read).toBe(1);
    expect((await http(app).post('/v1/me/inbox/read', { ids: [first.data[0].id] }, { token: p.access })).body.data.read).toBe(0); // already read
    expect((await http(app).get('/v1/me/inbox', { token: p.access })).body.meta.unread).toBe(4);
    expect((await http(app).post('/v1/me/inbox/read', { all: true }, { token: p.access })).body.data.read).toBe(4);
    expect((await http(app).post('/v1/me/inbox/read', {}, { token: p.access })).status).toBe(400);
    const other = await phone();
    expect((await http(app).get('/v1/me/inbox', { token: other.access })).body.data).toEqual([]); // nobody else's items
  });
});

describe('P8 daily nudge', () => {
  it('goes out at each person\'s own reminder time across five zones, with the first name, once a day', async () => {
    const now = Date.parse('2025-06-02T04:30:00Z');
    const zones = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Karachi', 'Australia/Sydney'];
    const people = await Promise.all(zones.map((tz, i) => phone({ tz, name: `P${i}`, reminder: localClock(now, tz).hhmm })));
    const late = await phone({ tz: 'UTC', reminder: '23:15' });
    await push().minute(now);
    for (const [i, p] of people.entries()) {
      expect(to(p), zones[i]).toHaveLength(1);
      expect(to(p)[0]).toMatchObject({ title: 'WeHum', data: { type: 'daily_nudge', deepLink: 'wehum://today' } });
      expect(to(p)[0]!.body).toContain(`P${i}`);
    }
    expect(to(late)).toHaveLength(0);
    sent = [];
    await push().minute(now); // the same minute again (a retried job)
    await push().minute(now + 30_000);
    expect(sent).toHaveLength(0);
    expect((await q(`SELECT count(*)::int AS n FROM push_log WHERE key='daily_nudge'`))[0]!.n).toBe(5);
  });

  it('on the day the clocks go back, the repeated hour sends only once', async () => {
    const p = await phone({ tz: 'Europe/Berlin', reminder: '02:30' });
    await push().minute(Date.parse('2026-10-25T00:30:00Z')); // 02:30 CEST
    await push().minute(Date.parse('2026-10-25T01:30:00Z')); // 02:30 CET, the same local day
    expect(to(p)).toHaveLength(1);
    await push().minute(Date.parse('2026-10-26T01:30:00Z')); // next day: again
    expect(to(p)).toHaveLength(2);
  });

  it('nobody without a token, with reminders off, or with the nudge switched off gets it; bad tokens are removed', async () => {
    const now = Date.parse('2026-11-02T08:00:00Z');
    const off = await phone({ reminder: '08:00', enabled: false });
    const bad = await phone({ reminder: '08:00', token: 'bad-token-0001' });
    const none = await guest(app);
    await q(`UPDATE users SET reminder_time='08:00' WHERE id=$1`, [none.me.id]);
    await push().minute(now);
    expect(to(off)).toHaveLength(0);
    expect(to(bad)).toHaveLength(1);
    expect((await q(`SELECT push_token FROM devices WHERE install_id=$1`, [bad.installId]))[0]!.push_token).toBeNull(); // cleaned up
    sent = [];
    await q(`UPDATE auto_notifications SET enabled=false WHERE key IN ('daily_nudge','daily_message')`);
    const on = await phone({ reminder: '08:00' });
    await push().minute(Date.parse('2026-11-03T08:00:00Z'));
    expect(to(on)).toHaveLength(0);
    await q(`UPDATE auto_notifications SET enabled=true WHERE key IN ('daily_nudge','daily_message')`);
  });

  it('a live message of the day and the nudge are one push (with the message), unless the person opted out of message pushes', async () => {
    const now = Date.parse('2026-11-10T09:00:00Z');
    await q(`INSERT INTO daily_messages (date, type, title, text, status) VALUES ('2026-11-10','text','Between two breaths','x','live')`);
    const wants = await phone({ reminder: '09:00' });
    const declined = await phone({ reminder: '09:00' });
    await q(`UPDATE users SET daily_message_push=false WHERE id=$1`, [declined.id]);
    await push().minute(now);
    expect(to(wants)).toHaveLength(1);
    expect(to(wants)[0]).toMatchObject({ title: 'Today’s message from Raphael', body: 'Between two breaths', data: { type: 'daily_message' } });
    expect(to(declined)).toHaveLength(1);
    expect(to(declined)[0]!.data.type).toBe('daily_nudge');
    await push().minute(now);
    expect(sent).toHaveLength(2); // still one each
    expect((await q(`SELECT count(*)::int AS n FROM auto_notifications WHERE delivered > 0`))[0]!.n).toBeGreaterThanOrEqual(2);
  });
});

describe('P8 group warning and trial ending', () => {
  it('group warning: once, in the minute before the start, to opted-in people and to those who tapped "Remind me"', async () => {
    const now = Date.parse('2026-12-01T15:50:00Z');
    await q(`UPDATE app_config SET value = jsonb_set(jsonb_set(value, '{startUtc}', '"16:00"'), '{reminderMin}', '10') WHERE key='group'`);
    await q(`DELETE FROM app_config WHERE key='group' AND false`);
    const optedIn = await phone({ reminder: '03:00' }); await q(`UPDATE users SET group_warning=true WHERE id=$1`, [optedIn.id]);
    const tapped = await phone({ reminder: '03:00' });
    const neither = await phone({ reminder: '03:00' });
    // "Remind me" through the API: the next group is today's (not over yet at `now`)
    const redis = (await import('ioredis')).default;
    const r = new redis(process.env.REDIS_URL!);
    await r.sadd('lobby:remind:2026-12-01', tapped.id);
    await push().minute(now - 120_000); // too early
    expect(sent.filter((m) => m.data.type === 'group_warning')).toHaveLength(0);
    await push().minute(now + 20_000);
    const got = sent.filter((m) => m.data.type === 'group_warning');
    expect(got.map((m) => m.token).sort()).toEqual([optedIn.token, tapped.token].sort());
    expect(got[0]!.body).toContain('16:00 UTC');
    expect(to(neither).filter((m) => m.data.type === 'group_warning')).toHaveLength(0);
    sent = [];
    await push().minute(now + 40_000); // same minute again
    expect(sent.filter((m) => m.data.type === 'group_warning')).toHaveLength(0);
    await r.quit();
  });

  it('"Remind me" and "don\'t remind me" through the API', async () => {
    const p = await phone();
    const on = await http(app).put('/v1/group/remind', {}, { token: p.access });
    expect(on.body.data).toMatchObject({ reminding: true, date: expect.any(String) });
    const redis = (await import('ioredis')).default;
    const r = new redis(process.env.REDIS_URL!);
    expect(await r.sismember(`lobby:remind:${on.body.data.date}`, p.id)).toBe(1);
    expect((await http(app).del('/v1/group/remind', { token: p.access })).body.data.reminding).toBe(false);
    expect(await r.sismember(`lobby:remind:${on.body.data.date}`, p.id)).toBe(0);
    await r.quit();
  });

  it('trial ending: two days before, push + inbox, once; not for paid or other windows', async () => {
    const now = Date.parse('2026-12-10T12:00:00Z');
    const mk = async (hours: number, period = 'trial') => {
      const p = await phone({ reminder: '03:00' });
      await q(`INSERT INTO entitlements (user_id, active, product_id, period_type, expires_at) VALUES ($1,true,'wehum_annual',$2,$3)`, [p.id, period, new Date(now + hours * HOUR)]);
      return p;
    };
    const due = await mk(48), early = await mk(60), paid = await mk(48, 'normal'), late = await mk(30);
    expect(await push().trialEnding(now)).toBe(1);
    expect(to(due)).toHaveLength(1);
    expect(to(due)[0]).toMatchObject({ title: 'Your trial ends in 2 days', data: { type: 'trial_ending' } });
    for (const p of [early, paid, late]) expect(to(p)).toHaveLength(0);
    expect((await q(`SELECT type FROM inbox_items WHERE user_id=$1`, [due.id])).map((r) => r.type)).toEqual(['trial_ending']);
    expect(await push().trialEnding(now + 10 * 60_000)).toBe(0); // idempotent that day
  });
});

describe('P8 announcements', () => {
  const draft = async (over: Record<string, unknown> = {}, t = owner) => (await A(t).post('/v1/admin/notifications', { title: 'Hello', body: 'A short note', audience: 'country', countries: ['QQ'], ...over })).body.data;

  it('roles: editors write drafts, only owner/admin send; moderators have nothing', async () => {
    expect((await A(mod).get('/v1/admin/notifications')).status).toBe(403);
    const d = await draft({}, editor);
    expect(d).toMatchObject({ status: 'draft', version: 1 });
    expect((await A(editor).post(`/v1/admin/notifications/${d.id}/send`)).status).toBe(403);
    expect((await A(editor).post(`/v1/admin/notifications/${d.id}/cancel`)).status).toBe(403);
    expect((await A(editor).patch('/v1/admin/notifications/automatic/daily_nudge', { enabled: false })).status).toBe(403);
    expect((await A(editor).get('/v1/admin/notifications/automatic')).status).toBe(200);
    const edit = await A(editor).patch(`/v1/admin/notifications/${d.id}`, { body: 'Edited' });
    expect(edit.body.data).toMatchObject({ body: 'Edited', version: 2 });
  });

  it('validation: lengths, country audience needs countries, links, schedule in the future', async () => {
    const bad = (b: object) => A(owner).post('/v1/admin/notifications', { title: 'T', body: 'B', ...b });
    expect((await bad({ title: 'x'.repeat(51) })).status).toBe(400);
    expect((await bad({ body: 'x'.repeat(151) })).status).toBe(400);
    expect((await bad({ audience: 'country' })).status).toBe(400);
    expect((await bad({ deepLink: 'javascript:alert(1)' })).status).toBe(400);
    expect((await bad({ sendMode: 'scheduled' })).status).toBe(400);
    expect((await bad({ sendMode: 'scheduled', sendAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await bad({ sendMode: 'scheduled', sendAt: new Date(Date.now() + HOUR).toISOString() })).status).toBe(201);
    expect((await bad({ nope: 1 })).status).toBe(400);
  });

  it('audience preview counts people with push turned on; "send" refuses an empty audience', async () => {
    const a = await phone({ country: 'QQ' }), b = await phone({ country: 'QQ' });
    await q(`INSERT INTO entitlements (user_id, active, product_id, period_type, expires_at) VALUES ($1,true,'wehum_annual','normal', now() + interval '10 days')`, [a.id]);
    const no = await guest(app); await q(`UPDATE users SET country='QQ' WHERE id=$1`, [no.me.id]); // no token: cannot be reached
    const count = async (qs: string) => (await A(owner).get(`/v1/admin/notifications/audience?${qs}`)).body.data.targeted;
    expect(await count('audience=country&countries=QQ')).toBe(2);
    expect(await count('audience=country&countries=QQ,ZZ')).toBeGreaterThanOrEqual(2);
    expect(await count('audience=country&countries=NOPE')).toBe(0);
    const empty = await draft({ countries: ['XX'] });
    const r = await A(owner).post(`/v1/admin/notifications/${empty.id}/send`);
    expect(r.status).toBe(422);
    void b;
  });

  it('send now: delivered, counted, stats announced, inbox written, a second send refused; nothing twice', async () => {
    const people = await Promise.all([phone({ country: 'NA' }), phone({ country: 'NA' }), phone({ country: 'NA', token: 'fail-token-0001' })]);
    const d = await draft({ countries: ['NA'], title: 'New meditation', body: 'Out now', deepLink: 'wehum://library' });
    const r = await A(adminTok).post(`/v1/admin/notifications/${d.id}/send`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ targeted: 3, status: 'sent', delivered: 2, failed: 1 });
    expect(sent.filter((m) => m.data.notificationId === d.id)).toHaveLength(3);
    expect(sent[0]!.data).toMatchObject({ type: 'announcement', deepLink: 'wehum://library', notificationId: d.id });
    expect((await q(`SELECT count(*)::int AS n FROM inbox_items WHERE type='announcement' AND title='New meditation'`))[0]!.n).toBe(2);
    await push().minute(Date.now()); // the minute job must not send it again
    expect(sent.filter((m) => m.data.notificationId === d.id)).toHaveLength(3);
    expect((await A(adminTok).post(`/v1/admin/notifications/${d.id}/send`)).status).toBe(422);
    await new Promise((r2) => setTimeout(r2, 250));
    expect(bus.some((e) => e.topic === 'notification:stats' && e.payload.id === d.id && e.payload.delivered === 2)).toBe(true);
    expect((await q(`SELECT 1 FROM audit_log WHERE action='notification.send' AND target_id=$1`, [d.id])).length).toBe(1);
    void people;
  });

  it('quiet hours: people at night wait until 07:00 their time; the others get it now', async () => {
    const now = Date.parse('2026-09-01T21:00:00Z'); // Berlin 23:00 (night), UTC 21:00 (day)
    const night = await phone({ country: 'NB', tz: 'Europe/Berlin' });
    const day = await phone({ country: 'NB', tz: 'UTC' });
    const d = await draft({ countries: ['NB'] });
    await q(`UPDATE notifications SET status='sending', targeted=2, send_at=$2 WHERE id=$1`, [d.id, new Date(now)]);
    await push().announcements(now);
    expect(to(day)).toHaveLength(1);
    expect(to(night)).toHaveLength(0);
    expect((await q(`SELECT status FROM notifications WHERE id=$1`, [d.id]))[0]!.status).toBe('sending'); // still waiting for someone
    await push().announcements(now + 6 * HOUR + 30 * 60_000); // Berlin 05:30: still quiet
    expect(to(night)).toHaveLength(0);
    await push().announcements(now + 8 * HOUR); // Berlin 07:00
    expect(to(night)).toHaveLength(1);
    expect((await q(`SELECT status, delivered FROM notifications WHERE id=$1`, [d.id]))[0]).toMatchObject({ status: 'sent', delivered: 2 });
    const preview = (await A(owner).get(`/v1/admin/notifications/audience?audience=country&countries=NB&at=${new Date(now).toISOString()}`)).body.data;
    expect(preview).toMatchObject({ targeted: 2, quiet: 1, quietHours: { start: '22:00', end: '07:00' } });
  });

  it('scheduled: waits for its time, then sends; can be cancelled before; at each person\'s reminder time when asked', async () => {
    const at = new Date(Date.now() + 2 * HOUR);
    // a time zone where the send moment is daytime: inside quiet hours (22–07) it would rightly wait (the test ran at night)
    const hourAt = (tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(at));
    const tz = ['UTC', 'Asia/Tokyo', 'America/New_York', 'Asia/Kolkata', 'Pacific/Honolulu', 'Europe/Berlin'].find((z) => hourAt(z) >= 9 && hourAt(z) < 20)!;
    const early = await phone({ country: 'NC', reminder: '07:30', tz }), later = await phone({ country: 'NC', reminder: '18:00', tz });
    const sch = await draft({ countries: ['NC'], sendMode: 'scheduled', sendAt: at.toISOString() });
    const s = await A(owner).post(`/v1/admin/notifications/${sch.id}/send`);
    expect(s.body.data.status).toBe('scheduled');
    await push().minute(Date.now());
    expect(to(early)).toHaveLength(0);
    await push().minute(at.getTime() + 60_000);
    expect(to(early)).toHaveLength(1);
    expect(to(later)).toHaveLength(1);

    const gone = await draft({ countries: ['NC'], sendMode: 'scheduled', sendAt: new Date(Date.now() + 3 * HOUR).toISOString() });
    await A(owner).post(`/v1/admin/notifications/${gone.id}/send`);
    expect((await A(owner).post(`/v1/admin/notifications/${gone.id}/cancel`)).body.data.status).toBe('cancelled');
    sent = [];
    await push().minute(Date.now() + 4 * HOUR);
    expect(sent.filter((m) => m.data.notificationId === gone.id)).toHaveLength(0);
    expect((await A(owner).post(`/v1/admin/notifications/${gone.id}/cancel`)).status).toBe(422);

    const p1 = await phone({ country: 'ND', reminder: '09:00' }), p2 = await phone({ country: 'ND', reminder: '16:00' });
    const rem = await draft({ countries: ['ND'], sendMode: 'user_reminder_time' });
    const base = Date.parse('2026-09-02T00:00:00Z');
    await q(`UPDATE notifications SET status='sending', send_at=$2 WHERE id=$1`, [rem.id, new Date(base)]);
    await push().announcements(base + 8 * HOUR + 30 * 60_000); // 08:30: nobody's reminder time yet
    expect(sent.filter((m) => m.data.notificationId === rem.id)).toHaveLength(0);
    await push().announcements(base + 9 * HOUR + 5 * 60_000);
    expect(to(p1).filter((m) => m.data.notificationId === rem.id)).toHaveLength(1);
    expect(to(p2).filter((m) => m.data.notificationId === rem.id)).toHaveLength(0);
    await push().announcements(base + 16 * HOUR + 5 * 60_000);
    expect(to(p2).filter((m) => m.data.notificationId === rem.id)).toHaveLength(1);
  });

  it('send test to me: goes to the app account with that email and is not counted; unknown email is explained', async () => {
    const me = await phone({ country: 'NE' });
    await q(`UPDATE users SET email='admin.phone@wehum.test' WHERE id=$1`, [me.id]);
    const d = await draft({ countries: ['NE'], title: 'Hello world' });
    const ok = await A(owner).post(`/v1/admin/notifications/${d.id}/test`, { email: 'admin.phone@wehum.test' });
    expect(ok.status).toBe(200);
    expect(to(me)[0]!.title).toBe('[Test] Hello world');
    expect((await q(`SELECT delivered, targeted FROM notifications WHERE id=$1`, [d.id]))[0]).toMatchObject({ delivered: 0, targeted: 0 });
    expect((await A(owner).post(`/v1/admin/notifications/${d.id}/test`, { email: 'nobody@wehum.test' })).status).toBe(404);
  });

  it('automatic notifications: list, edit copy, switch off; opened is counted once per person and day', async () => {
    const auto = (await A(editor).get('/v1/admin/notifications/automatic')).body.data;
    expect(auto.map((a: { key: string }) => a.key)).toEqual(expect.arrayContaining(['daily_nudge', 'daily_message', 'group_warning', 'trial_ending']));
    const edited = await A(adminTok).patch('/v1/admin/notifications/automatic/trial_ending', { body: 'Three more days of calm.' });
    expect(edited.body.data).toMatchObject({ key: 'trial_ending', body: 'Three more days of calm.' });
    expect((await A(adminTok).patch('/v1/admin/notifications/automatic/nope', { enabled: false })).status).toBe(404);
    expect((await A(adminTok).patch('/v1/admin/notifications/automatic/daily_nudge', { title: 'x'.repeat(51) })).status).toBe(400);

    const p = await phone({ country: 'NF', reminder: '10:00' });
    const nowTs = Date.parse('2026-09-03T10:00:00Z');
    await push().minute(nowTs);
    const before = (await q(`SELECT opened FROM auto_notifications WHERE key='daily_nudge'`))[0]!.opened;
    expect(await push().markOpened(p.id, 'daily_nudge')).toBe(true);
    expect(await push().markOpened(p.id, 'daily_nudge')).toBe(false);
    expect((await q(`SELECT opened FROM auto_notifications WHERE key='daily_nudge'`))[0]!.opened).toBe(before + 1);
    const d = await draft({ countries: ['NF'] });
    await A(owner).post(`/v1/admin/notifications/${d.id}/send`);
    expect(await push().markOpened(p.id, `ann:${d.id}`)).toBe(true);
    expect((await q(`SELECT opened FROM notifications WHERE id=$1`, [d.id]))[0]!.opened).toBe(1);
  });
});
