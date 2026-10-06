import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { analyticsEvents, dailyAggregates } from '../../db/schema';
import { AppError } from '../../common/errors';
import type { AppUser } from '../../common/auth';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { PushService } from '../push/push.service';

export interface EventIn { name: string; props?: Record<string, unknown>; at?: string; key?: string }
const DAY = 86_400_000;
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDay = (d: string, n: number) => utcDay(Date.parse(`${d}T00:00:00Z`) + n * DAY);
export const FUNNEL = ['installed', 'introDone', 'firstMeditation', 'continuedFree', 'trialStarted', 'savedAccount', 'paid'] as const;
type Funnel = Record<(typeof FUNNEL)[number], number>;

@Injectable()
export class AnalyticsService {
  private readonly log = new Logger('Analytics');
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly push: PushService) {}

  // ───────────── ingest (fire and forget: the app never waits for this)
  /** Product events from the app (≤ 50 per call). `push_open` is also counted on the notification. */
  async ingest(user: AppUser, events: EventIn[], meta: { platform?: string; appVersion?: string }) {
    const now = Date.now();
    const rows = events.map((e) => {
      const at = e.at ? Math.min(Date.parse(e.at), now) : now;
      return { userId: user.id, installId: user.installId ?? null, name: e.name, props: { ...(e.props ?? {}), ...(e.key ? { key: e.key } : {}) }, platform: (meta.platform === 'android' ? 'android' : meta.platform === 'ios' ? 'ios' : null) as 'ios' | 'android' | null, appVersion: meta.appVersion?.slice(0, 20) ?? null, at: new Date(Number.isNaN(at) ? now : Math.max(at, now - 7 * DAY)) };
    });
    await this.db.insert(analyticsEvents).values(rows);
    for (const e of events) if (e.name === 'push_open' && e.key) await this.push.markOpened(user.id, e.key).catch(() => false);
    return rows.length;
  }

  // ───────────── rollup (spec §6.4)
  /** One day, UTC. Idempotent: the row is replaced. `today` also takes the day's peak of people meditating together. */
  async rollup(date: string) {
    const from = new Date(`${date}T00:00:00Z`), to = new Date(from.getTime() + DAY);
    const r = (q: ReturnType<typeof sql>) => this.db.execute<Record<string, string | number | null>>(q).then((x) => x.rows);
    const [[med], [active], [newUsers], [trials], [paid], [cancel], [revenue], countries, themes, [funnelRow]] = await Promise.all([
      r(sql`SELECT count(*) FILTER (WHERE counted)::int AS meditations, coalesce(sum(duration_sec) FILTER (WHERE counted), 0)::int / 60 AS minutes, count(*) FILTER (WHERE counted AND kind = 'group')::int AS grp FROM meditations WHERE started_at >= ${from} AND started_at < ${to}`),
      r(sql`SELECT count(DISTINCT uid)::int AS n FROM (SELECT user_id AS uid FROM meditations WHERE started_at >= ${from} AND started_at < ${to} UNION SELECT user_id FROM analytics_events WHERE name = 'app_open' AND at >= ${from} AND at < ${to} AND user_id IS NOT NULL) a`),
      r(sql`SELECT count(*)::int AS n FROM users WHERE created_at >= ${from} AND created_at < ${to}`),
      r(sql`SELECT count(*)::int AS n FROM subscription_events WHERE type = 'INITIAL_PURCHASE' AND period_type = 'trial' AND event_at >= ${from} AND event_at < ${to}`),
      r(sql`SELECT (
        (SELECT count(*) FROM subscription_events WHERE type = 'INITIAL_PURCHASE' AND period_type IN ('normal','intro') AND event_at >= ${from} AND event_at < ${to})
        + (SELECT count(*) FROM subscription_events c WHERE c.type = 'RENEWAL' AND c.event_at >= ${from} AND c.event_at < ${to}
            AND EXISTS (SELECT 1 FROM subscription_events t WHERE t.user_id = c.user_id AND t.type = 'INITIAL_PURCHASE' AND t.period_type = 'trial' AND t.event_at < c.event_at)
            AND NOT EXISTS (SELECT 1 FROM subscription_events p WHERE p.user_id = c.user_id AND p.type = 'RENEWAL' AND p.event_at < c.event_at))
        )::int AS n`),
      r(sql`SELECT count(*)::int AS n FROM subscription_events WHERE type = 'CANCELLATION' AND event_at >= ${from} AND event_at < ${to}`),
      r(sql`SELECT coalesce(sum(price_usd), 0)::text AS n FROM subscription_events WHERE type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') AND price_usd > 0 AND event_at >= ${from} AND event_at < ${to}`),
      r(sql`SELECT coalesce(country, '??') AS k, count(DISTINCT user_id)::int AS n FROM meditations WHERE counted AND started_at >= ${from} AND started_at < ${to} GROUP BY 1`),
      r(sql`SELECT t.name AS k, coalesce(sum(m.duration_sec), 0)::int / 60 AS n FROM meditations m JOIN sessions s ON s.id = m.session_id JOIN themes t ON t.id = s.theme_id WHERE m.counted AND m.started_at >= ${from} AND m.started_at < ${to} GROUP BY 1`),
      r(sql`SELECT
        (SELECT count(*) FROM users WHERE created_at >= ${from} AND created_at < ${to})::int AS "installed",
        (SELECT count(DISTINCT user_id) FROM analytics_events WHERE name = 'intro_done' AND at >= ${from} AND at < ${to})::int AS "introDone",
        (SELECT count(*) FROM user_stats WHERE first_meditation_at >= ${from} AND first_meditation_at < ${to})::int AS "firstMeditation",
        (SELECT count(DISTINCT user_id) FROM analytics_events WHERE name = 'continued_free' AND at >= ${from} AND at < ${to})::int AS "continuedFree",
        (SELECT count(DISTINCT user_id) FROM analytics_events WHERE name = 'account_saved' AND at >= ${from} AND at < ${to})::int AS "savedAccount"`),
    ]);
    const peak = Math.max(Number(await this.redis.get(`live:peak:${date}`)) || 0, 0);
    const values = {
      date, meditations: Number(med!.meditations), minutes: Number(med!.minutes), groupMeditations: Number(med!.grp), activeUsers: Number(active!.n), newUsers: Number(newUsers!.n),
      newTrials: Number(trials!.n), newPaid: Number(paid!.n), cancellations: Number(cancel!.n), revenueUsd: String(revenue!.n),
      countries: Object.fromEntries(countries.map((c) => [String(c.k), Number(c.n)])), byTheme: Object.fromEntries(themes.map((t) => [String(t.k), Number(t.n)])),
      funnel: { installed: Number(funnelRow!.installed), introDone: Number(funnelRow!.introDone), firstMeditation: Number(funnelRow!.firstMeditation), continuedFree: Number(funnelRow!.continuedFree), trialStarted: Number(trials!.n), savedAccount: Number(funnelRow!.savedAccount), paid: Number(paid!.n) } satisfies Funnel,
    };
    const { date: _date, ...set } = values;
    void _date;
    await this.db.insert(dailyAggregates).values({ ...values, peakLive: peak }).onConflictDoUpdate({ target: dailyAggregates.date, set: { ...set, peakLive: sql`greatest(${dailyAggregates.peakLive}, ${peak})`, updatedAt: new Date() } });
    return values;
  }

  /** Hourly job: today, plus yesterday until its final run (00:30 UTC) has happened. */
  async rollupRecent(now = Date.now()) {
    const today = utcDay(now);
    await this.rollup(today);
    if (now - Date.parse(`${today}T00:00:00Z`) < 90 * 60_000) await this.rollup(addDay(today, -1));
  }

  // ───────────── admin reads (daily_aggregates)
  private async days(from: string, to: string) {
    const res = await this.db.execute<{ date: string; meditations: number; minutes: number; group_meditations: number; active_users: number; new_users: number; new_trials: number; new_paid: number; cancellations: number; revenue_usd: string; peak_live: number; countries: Record<string, number>; by_theme: Record<string, number>; funnel: Partial<Funnel> }>(
      sql`SELECT date::text, meditations, minutes, group_meditations, active_users, new_users, new_trials, new_paid, cancellations, revenue_usd::text, peak_live, countries, by_theme, funnel FROM daily_aggregates WHERE date >= ${from} AND date <= ${to} ORDER BY date`);
    return res.rows;
  }

  private period(period: number, now = Date.now()) {
    const to = utcDay(now), from = addDay(to, -(period - 1));
    return { from, to, prevFrom: addDay(from, -period), prevTo: addDay(from, -1) };
  }

  async trends(period: number, now = Date.now()) {
    const p = this.period(period, now);
    const [cur, prev, distinct] = await Promise.all([this.days(p.from, p.to), this.days(p.prevFrom, p.prevTo), this.distinctActive(p.from, p.to, p.prevFrom, p.prevTo)]);
    const sum = <K extends keyof (typeof cur)[number]>(rows: typeof cur, k: K) => rows.reduce((s, r) => s + Number(r[k]), 0);
    const kpi = (value: number | null, previous: number | null) => ({ value, previous, deltaPct: value !== null && previous ? Math.round(((value - previous) / previous) * 1000) / 10 : null });
    const avg = (rows: typeof cur) => { const m = sum(rows, 'meditations'); return m ? Math.round((sum(rows, 'minutes') / m) * 10) / 10 : null; };
    const themes = new Map<string, number>(), countries = new Map<string, number>();
    for (const r of cur) { for (const [k, v] of Object.entries(r.by_theme)) themes.set(k, (themes.get(k) ?? 0) + v); for (const [k, v] of Object.entries(r.countries)) countries.set(k, (countries.get(k) ?? 0) + v); }
    const top = (m: Map<string, number>, n: number) => {
      const all = [...m.entries()].sort((a, b) => b[1] - a[1]); const total = all.reduce((s, [, v]) => s + v, 0);
      const head = all.slice(0, n).map(([name, value]) => ({ name, value, share: total ? value / total : 0 }));
      const rest = all.slice(n).reduce((s, [, v]) => s + v, 0);
      return rest ? [...head, { name: 'Other', value: rest, share: rest / total }] : head;
    };
    return {
      period, from: p.from, to: p.to, tz: 'UTC',
      kpis: {
        activeUsers: kpi(distinct.cur, distinct.prev), meditations: kpi(sum(cur, 'meditations'), sum(prev, 'meditations')), minutes: kpi(sum(cur, 'minutes'), sum(prev, 'minutes')),
        avgLengthMin: kpi(avg(cur), avg(prev)), newPaying: kpi(sum(cur, 'new_paid'), sum(prev, 'new_paid')),
      },
      perDay: cur.map((r) => ({ date: r.date, solo: r.meditations - r.group_meditations, group: r.group_meditations, minutes: r.minutes, activeUsers: r.active_users, newUsers: r.new_users })),
      byTheme: top(themes, 5).map((t) => ({ theme: t.name, minutes: t.value, share: t.share })),
      countries: top(countries, 4).map((c) => ({ country: c.name, members: c.value, share: c.share })),
      peakLive: Math.max(0, ...cur.map((r) => r.peak_live)),
    };
  }

  /** Distinct people over the whole period (a sum of daily numbers would count the same person many times). */
  private async distinctActive(from: string, to: string, pFrom: string, pTo: string) {
    const q = (a: string, b: string) => this.db.execute<{ n: number }>(sql`SELECT count(DISTINCT user_id)::int AS n FROM meditations WHERE started_at >= ${new Date(`${a}T00:00:00Z`)} AND started_at < ${new Date(Date.parse(`${b}T00:00:00Z`) + DAY)}`).then((r) => r.rows[0]?.n ?? 0);
    const [cur, prev] = await Promise.all([q(from, to), q(pFrom, pTo)]);
    return { cur, prev };
  }

  async funnel(period: number, now = Date.now()) {
    const p = this.period(period, now);
    const rows = await this.days(p.from, p.to);
    const total = Object.fromEntries(FUNNEL.map((k) => [k, rows.reduce((s, r) => s + Number(r.funnel[k] ?? 0), 0)])) as Funnel;
    const base = total.installed;
    return { period, from: p.from, to: p.to, steps: FUNNEL.map((k) => ({ key: k, count: total[k], share: base ? total[k] / base : null })) };
  }

  /** D1 / D7 / D30: of the people who joined N days ago or earlier (within the window), the share who meditated exactly N days after joining. Cached 10 min. */
  async retention(now = Date.now()) {
    const key = `retention:${utcDay(now)}`;
    const hit = await this.redis.get(key).catch(() => null);
    if (hit) return JSON.parse(hit);
    const out: { day: number; cohort: number; retained: number; rate: number | null }[] = [];
    for (const n of [1, 7, 30]) {
      const lastJoin = addDay(utcDay(now), -n), firstJoin = addDay(lastJoin, -29); // 30 daily cohorts that are old enough
      const [row] = (await this.db.execute<{ cohort: number; retained: number }>(sql`
        SELECT count(*)::int AS cohort,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM meditations m WHERE m.user_id = u.id AND m.counted AND (m.started_at AT TIME ZONE 'UTC')::date = (u.created_at AT TIME ZONE 'UTC')::date + ${n}::int))::int AS retained
        FROM users u WHERE (u.created_at AT TIME ZONE 'UTC')::date BETWEEN ${firstJoin}::date AND ${lastJoin}::date`)).rows;
      out.push({ day: n, cohort: row?.cohort ?? 0, retained: row?.retained ?? 0, rate: row?.cohort ? row.retained / row.cohort : null });
    }
    const res = { retention: out, at: new Date(now).toISOString() };
    await this.redis.set(key, JSON.stringify(res), 'EX', 600).catch(() => null);
    return res;
  }

  async exportCsv(period: number, now = Date.now()) {
    const p = this.period(period, now);
    const rows = await this.days(p.from, p.to);
    const head = ['date', 'meditations', 'solo', 'group', 'minutes', 'active_users', 'new_users', 'new_trials', 'new_paid', 'cancellations', 'revenue_usd', 'peak_live'];
    return [head.join(','), ...rows.map((r) => [r.date, r.meditations, r.meditations - r.group_meditations, r.group_meditations, r.minutes, r.active_users, r.new_users, r.new_trials, r.new_paid, r.cancellations, r.revenue_usd, r.peak_live].join(','))].join('\n') + '\n';
  }

  /** Aggregates for the dashboard's "vs last Thursday" and top sessions (live from meditations: small ranges, indexed). */
  async topSessions(days = 7, limit = 5) {
    const since = new Date(Date.now() - days * DAY);
    const res = await this.db.execute<{ id: string; title: string; theme: string | null; plays: number; completion: number | null }>(sql`
      SELECT s.id, s.title, t.name AS theme, count(*)::int AS plays, avg(CASE WHEN m.completed THEN 1.0 ELSE 0.0 END)::float AS completion
      FROM meditations m JOIN sessions s ON s.id = m.session_id LEFT JOIN themes t ON t.id = s.theme_id
      WHERE m.started_at >= ${since} GROUP BY s.id, s.title, t.name ORDER BY plays DESC LIMIT ${limit}`);
    return res.rows;
  }

  async medsOn(date: string): Promise<number> {
    const live = Number(await this.redis.get(K.medsToday(date)));
    if (live) return live;
    const [r] = (await this.db.execute<{ n: number }>(sql`SELECT meditations AS n FROM daily_aggregates WHERE date = ${date}`)).rows;
    return r?.n ?? 0;
  }

  /** Nightly (03:00 UTC): old events, expired refresh tokens, guests nobody used for N months. */
  async lifecycle(now = Date.now()) {
    const months = Number((await this.db.execute<{ v: number }>(sql`SELECT (value->>'deleteInactiveGuestsMonths')::int AS v FROM app_config WHERE key = 'legal'`)).rows[0]?.v ?? 12);
    const events = await this.db.execute(sql`DELETE FROM analytics_events WHERE at < ${new Date(now - 13 * 30 * DAY)}`);
    const tokens = await this.db.execute(sql`DELETE FROM refresh_tokens WHERE expires_at < ${new Date(now - 7 * DAY)}`);
    const guests = await this.db.execute(sql`DELETE FROM users u WHERE u.is_guest AND u.last_active_at < ${new Date(now - months * 30 * DAY)}
      AND NOT EXISTS (SELECT 1 FROM entitlements e WHERE e.user_id = u.id AND e.active)`);
    // P10: published realtime events are only needed for a few days (debugging); unpublished ones are never removed
    const outbox = await this.db.execute(sql`DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < ${new Date(now - 7 * DAY)}`);
    this.log.log(`lifecycle: ${events.rowCount} events, ${tokens.rowCount} tokens, ${guests.rowCount} guests, ${outbox.rowCount} outbox rows`);
    return { events: events.rowCount ?? 0, tokens: tokens.rowCount ?? 0, guests: guests.rowCount ?? 0, outbox: outbox.rowCount ?? 0 };
  }

  assertPeriod(p: number) { if (![7, 14, 30, 90].includes(p)) throw new AppError('VALIDATION_FAILED', 'Period must be 7, 14, 30 or 90'); }
}
