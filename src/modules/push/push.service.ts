import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { autoNotifications, dailyMessages, devices, inboxItems, notifications, pushLog, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { RealtimeBus } from '../../infra/realtime-bus';
import { REDIS } from '../../infra/redis';
import { ConfigService } from '../config/config.service';
import { GroupService } from '../today/group.service';
import { metrics } from '../../infra/metrics';
import { PushTransport } from './push.transport';

export type Audience = 'all' | 'members' | 'free' | 'trial' | 'guests' | 'country' | 'founding';
export const QUIET_START = '22:00', QUIET_END = '07:00';
const BATCH = 2000;

/** The user's wall clock: local date and `HH:mm` (DST is handled by Intl). */
export function localClock(now: number, timeZone: string): { date: string; hhmm: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}
export const inQuietHours = (hhmm: string) => hhmm >= QUIET_START || hhmm < QUIET_END;
const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

/** Who an announcement goes to, as SQL over `users u` + `entitlements e` (left join). Only people with a push token can be reached. */
export function audienceWhere(a: Audience, countries: string[] = []): SQL {
  const member = sql`(e.active and (e.expires_at is null or e.expires_at > now()))`;
  const base = sql`u.deleted_at is null and exists (select 1 from devices d where d.user_id = u.id and d.push_token is not null)`;
  const by: Record<Audience, SQL> = {
    all: sql`true`, members: sql`${member}`, free: sql`not coalesce(${member}, false)`, trial: sql`(${member} and e.period_type = 'trial')`,
    guests: sql`u.is_guest`, founding: sql`(${member} and e.is_founding)`, country: countries.length ? sql`u.country in (${sql.join(countries.map((c) => sql`${c}`), sql`, `)})` : sql`false`,
  };
  return sql`${base} and ${by[a]}`;
}

@Injectable()
export class PushService {
  private readonly log = new Logger('PushService');
  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly bus: RealtimeBus,
    private readonly transport: PushTransport, private readonly config: ConfigService, private readonly group: GroupService,
  ) {}

  // ───────────── delivery
  /** Push to all devices of these users; invalid tokens are removed. Returns how many users got it and how many sends failed. */
  async deliver(userIds: string[], msg: { title: string; body: string; type: string; deepLink?: string | null; notificationId?: string }) {
    if (!userIds.length) return { delivered: [] as string[], failed: 0 };
    const devs = await this.db.select({ userId: devices.userId, token: devices.pushToken }).from(devices).where(and(inArray(devices.userId, userIds), sql`${devices.pushToken} is not null`));
    const data: Record<string, string> = { type: msg.type, deepLink: msg.deepLink ?? '', ...(msg.notificationId && { notificationId: msg.notificationId }) };
    const results = await this.transport.send(devs.map((d) => ({ token: d.token!, title: msg.title, body: msg.body, data })));
    const status = new Map(results.map((r) => [r.token, r.status]));
    const invalid = results.filter((r) => r.status === 'invalid').map((r) => r.token);
    if (invalid.length) await this.db.update(devices).set({ pushToken: null }).where(inArray(devices.pushToken, invalid));
    const ok = new Set<string>();
    let failed = 0;
    for (const d of devs) { if (status.get(d.token!) === 'ok') ok.add(d.userId); else failed++; }
    metrics.pushSent.inc({ key: msg.type, status: 'delivered' }, ok.size);
    if (failed) metrics.pushSent.inc({ key: msg.type, status: 'failed' }, failed);
    return { delivered: [...ok], failed };
  }

  /** `ON CONFLICT DO NOTHING` on the (user, key, local date) primary key: only the users that were not sent this key today come back. */
  private async claim(rows: { userId: string; date: string }[], key: string): Promise<Set<string>> {
    if (!rows.length) return new Set();
    const got = await this.db.insert(pushLog).values(rows.map((r) => ({ userId: r.userId, key, localDate: r.date }))).onConflictDoNothing().returning({ userId: pushLog.userId });
    return new Set(got.map((g) => g.userId));
  }

  async inbox(userIds: string[], item: { type: string; title: string; body: string; deepLink?: string | null }) {
    if (!userIds.length) return;
    const rows = userIds.map((userId) => ({ id: uuidv7(), userId, type: item.type, title: item.title.slice(0, 80), body: item.body.slice(0, 200), deepLink: item.deepLink ?? null }));
    for (let i = 0; i < rows.length; i += 1000) await this.db.insert(inboxItems).values(rows.slice(i, i + 1000));
    if (rows.length <= 500) await this.bus.publishMany(rows.map((r) => ({ topic: 'inbox:new', payload: { userId: r.userId, item: { id: r.id, type: r.type, title: r.title, body: r.body, deepLink: r.deepLink, createdAt: new Date().toISOString(), read: false } } })));
  }

  private async auto(key: string) { const [a] = await this.db.select().from(autoNotifications).where(eq(autoNotifications.key, key)); return a ?? null; }
  private async count(key: string, delivered: number) {
    if (delivered) await this.db.update(autoNotifications).set({ delivered: sql`${autoNotifications.delivered} + ${delivered}` }).where(eq(autoNotifications.key, key));
  }

  // ───────────── every minute
  /** Daily nudge / daily message at each user's reminder time, group warning, announcements. Safe to run twice in a minute. */
  async minute(now = Date.now()) {
    const out = { nudges: 0, group: 0, announcements: 0 };
    const [nudge, message] = await Promise.all([this.auto('daily_nudge'), this.auto('daily_message')]);
    if (nudge?.enabled || message?.enabled) {
      const zones = await this.db.selectDistinct({ tz: users.timezone }).from(users).where(and(eq(users.reminderEnabled, true), sql`${users.deletedAt} is null`));
      for (const { tz } of zones) {
        const { date, hhmm } = localClock(now, tz);
        const due = await this.db.select({ id: users.id, firstName: users.firstName, messagePush: users.dailyMessagePush }).from(users)
          .where(and(eq(users.timezone, tz), eq(users.reminderEnabled, true), eq(users.reminderTime, hhmm), sql`${users.deletedAt} is null`,
            sql`exists (select 1 from devices d where d.user_id = users.id and d.push_token is not null)`));
        if (!due.length) continue;
        const [todays] = await this.db.select({ title: dailyMessages.title }).from(dailyMessages).where(and(eq(dailyMessages.date, date), eq(dailyMessages.status, 'live')));
        // "One push per day": a due message and the nudge are one push, with the message's copy.
        const withMessage = todays && message?.enabled ? due.filter((u) => u.messagePush) : [];
        const mset = await this.claim(withMessage.map((u) => ({ userId: u.id, date })), 'daily_message');
        if (mset.size) {
          await this.claim([...mset].map((userId) => ({ userId, date })), 'daily_nudge'); // the nudge is used up too
          const r = await this.deliver([...mset], { title: message!.title, body: fill(message!.body, { title: todays!.title }), type: 'daily_message', deepLink: 'wehum://today' });
          await this.count('daily_message', r.delivered.length);
          out.nudges += r.delivered.length;
        }
        if (nudge?.enabled) {
          const rest = due.filter((u) => !mset.has(u.id));
          const nset = await this.claim(rest.map((u) => ({ userId: u.id, date })), 'daily_nudge');
          const named = rest.filter((u) => nset.has(u.id)); // the copy has the first name, so one call per distinct text
          const byCopy = new Map<string, string[]>();
          for (const u of named) { const body = fill(nudge.body, { firstName: u.firstName?.trim() || 'friend' }); byCopy.set(body, [...(byCopy.get(body) ?? []), u.id]); }
          for (const [body, ids] of byCopy) {
            const r = await this.deliver(ids, { title: nudge.title, body, type: 'daily_nudge', deepLink: 'wehum://today' });
            await this.count('daily_nudge', r.delivered.length);
            out.nudges += r.delivered.length;
          }
        }
      }
    }
    out.group = await this.groupWarning(now);
    out.announcements = await this.announcements(now);
    return out;
  }

  /** Once, in the minute that is `reminderMin` before the group starts. */
  async groupWarning(now: number): Promise<number> {
    const auto = await this.auto('group_warning');
    if (!auto?.enabled) return 0;
    const today = new Date(now).toISOString().slice(0, 10);
    const g = await this.group.forDate(today, now);
    const warnAt = Date.parse(g.startsAt) - g.reminderMin * 60_000;
    if (now < warnAt || now >= warnAt + 60_000) return 0;
    if ((await this.redis.set(`push:group:${today}:${g.startsAt}`, '1', 'EX', 86_400, 'NX')) !== 'OK') return 0;
    const reminded = await this.redis.smembers(`lobby:remind:${today}`).catch(() => [] as string[]);
    const opted = await this.db.select({ id: users.id }).from(users).where(and(eq(users.groupWarning, true), sql`${users.deletedAt} is null`));
    const ids = [...new Set([...reminded, ...opted.map((o) => o.id)])];
    const time = new Date(g.startsAt).toISOString().slice(11, 16);
    const r = await this.deliver(ids, { title: auto.title, body: fill(auto.body, { title: g.title ?? 'The Meditation of the Day', time: `${time} UTC`, waiting: g.waiting }), type: 'group_warning', deepLink: 'wehum://group' });
    await this.count('group_warning', r.delivered.length);
    return r.delivered.length;
  }

  /** Daily: trials that end in about two days get a push and an inbox item, once. */
  async trialEnding(now = Date.now()): Promise<number> {
    const auto = await this.auto('trial_ending');
    if (!auto?.enabled) return 0;
    const rows = await this.db.execute<{ id: string }>(sql`SELECT u.id FROM users u JOIN entitlements e ON e.user_id = u.id
      WHERE e.active AND e.period_type = 'trial' AND e.expires_at BETWEEN ${new Date(now + 47 * 3_600_000)} AND ${new Date(now + 49 * 3_600_000)} AND u.deleted_at IS NULL`);
    const date = new Date(now).toISOString().slice(0, 10);
    const claimed = [...(await this.claim(rows.rows.map((r) => ({ userId: r.id, date })), 'trial_ending'))];
    await this.inbox(claimed, { type: 'trial_ending', title: auto.title, body: auto.body, deepLink: 'wehum://membership' });
    const r = await this.deliver(claimed, { title: auto.title, body: auto.body, type: 'trial_ending', deepLink: 'wehum://membership' });
    await this.count('trial_ending', r.delivered.length);
    return claimed.length;
  }

  // ───────────── announcements
  async audienceCount(a: Audience, countries: string[]): Promise<number> {
    const r = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM users u LEFT JOIN entitlements e ON e.user_id = u.id WHERE ${audienceWhere(a, countries)}`);
    return r.rows[0]?.n ?? 0;
  }

  /** How many of the audience are in quiet hours at `at` (they would get it at 07:00 local instead). */
  async quietCount(a: Audience, countries: string[], at: number): Promise<number> {
    const zones = await this.db.execute<{ tz: string; n: number }>(sql`SELECT u.timezone AS tz, count(*)::int AS n FROM users u LEFT JOIN entitlements e ON e.user_id = u.id WHERE ${audienceWhere(a, countries)} GROUP BY u.timezone`);
    return zones.rows.filter((z) => inQuietHours(localClock(at, z.tz).hhmm)).reduce((s, z) => s + z.n, 0);
  }

  private async stats(id: string) {
    const [n] = await this.db.select({ id: notifications.id, delivered: notifications.delivered, opened: notifications.opened, failed: notifications.failed }).from(notifications).where(eq(notifications.id, id));
    if (n) await this.bus.publish('notification:stats', n);
  }

  /** Moves due scheduled announcements to "sending" and sends the next batches. */
  async announcements(now: number): Promise<number> {
    await this.db.update(notifications).set({ status: 'sending' }).where(and(eq(notifications.status, 'scheduled'), sql`${notifications.sendAt} <= ${new Date(now)}`));
    const active = await this.db.select().from(notifications).where(eq(notifications.status, 'sending'));
    let sent = 0;
    for (const n of active) {
      const key = `ann:${n.id}`;
      const date = n.createdAt.toISOString().slice(0, 10);
      const zones = await this.db.execute<{ tz: string }>(sql`SELECT DISTINCT u.timezone AS tz FROM users u LEFT JOIN entitlements e ON e.user_id = u.id
        WHERE ${audienceWhere(n.audience, n.countries)} AND NOT EXISTS (SELECT 1 FROM push_log p WHERE p.user_id = u.id AND p.key = ${key})`);
      let remaining = 0;
      for (const { tz } of zones.rows) {
        const { hhmm } = localClock(now, tz);
        if (inQuietHours(hhmm)) { remaining++; continue; } // waits until 07:00 local
        const reminderGate = n.sendMode === 'user_reminder_time' ? sql`and u.reminder_time <= ${hhmm}` : sql``;
        const batch = await this.db.execute<{ id: string }>(sql`SELECT u.id FROM users u LEFT JOIN entitlements e ON e.user_id = u.id
          WHERE u.timezone = ${tz} AND ${audienceWhere(n.audience, n.countries)} ${reminderGate}
          AND NOT EXISTS (SELECT 1 FROM push_log p WHERE p.user_id = u.id AND p.key = ${key}) LIMIT ${BATCH}`);
        const claimed = [...(await this.claim(batch.rows.map((r) => ({ userId: r.id, date })), key))];
        if (claimed.length) {
          const r = await this.deliver(claimed, { title: n.title, body: n.body, type: 'announcement', deepLink: n.deepLink, notificationId: n.id });
          await this.db.update(notifications).set({ delivered: sql`${notifications.delivered} + ${r.delivered.length}`, failed: sql`${notifications.failed} + ${r.failed}` }).where(eq(notifications.id, n.id));
          await this.inbox(r.delivered, { type: 'announcement', title: n.title, body: n.body, deepLink: n.deepLink });
          sent += r.delivered.length;
        }
        if (batch.rows.length >= BATCH) remaining++;
        else if (n.sendMode === 'user_reminder_time') remaining++; // others may reach their reminder time later today
      }
      const tooOld = n.sendAt && now - n.sendAt.getTime() > 26 * 3_600_000;
      if (remaining === 0 || tooOld) await this.db.update(notifications).set({ status: 'sent' }).where(and(eq(notifications.id, n.id), eq(notifications.status, 'sending')));
      await this.stats(n.id);
    }
    return sent;
  }

  /** The app reports a tap on a push (`POST /v1/analytics/events {name: push_open, key}`); counted once per person and day. */
  async markOpened(userId: string, key: string) {
    const [row] = await this.db.update(pushLog).set({ openedAt: new Date() }).where(and(eq(pushLog.userId, userId), eq(pushLog.key, key), sql`${pushLog.openedAt} is null`)).returning({ localDate: pushLog.localDate });
    if (!row) return false;
    if (key.startsWith('ann:')) { await this.db.update(notifications).set({ opened: sql`${notifications.opened} + 1` }).where(eq(notifications.id, key.slice(4))); await this.stats(key.slice(4)); }
    else await this.db.update(autoNotifications).set({ opened: sql`${autoNotifications.opened} + 1` }).where(eq(autoNotifications.key, key));
    return true;
  }
}
