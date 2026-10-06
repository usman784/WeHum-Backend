import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { env } from '../config/env';
import { NEEDS_REVIEW } from '../modules/community/community.service';
import { dedications, entitlements, motdDays, offers } from '../db/schema';
import { DRIZZLE, type DB } from '../infra/core.module';
import { RealtimeBus } from '../infra/realtime-bus';
import { K, REDIS } from '../infra/redis';
import { SchedulerService } from '../jobs/scheduler';
import { LiveService } from '../modules/live/live.service';
import { addDaysIso } from '../modules/motd/motd.service';
import { GroupStartService } from './group-start.service';
import { LobbyService } from './lobby.service';
import { PresenceService } from './presence.service';
import { vibration } from './vibration';

/** Monthly value per product, used only for the dashboard's MRR estimate (RevenueCat stays the source of truth for money). */
export const MONTHLY_USD: Record<string, number> = { wehum_annual_founding: 59 / 12, wehum_annual: 79 / 12, wehum_monthly: 9.99 };

const hash = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('base64url');
const utcDay = (now: number, plus = 0) => addDaysIso(new Date(now).toISOString().slice(0, 10), plus);

/**
 * The leader's periodic work (spec §7.4, §7.5, §8.7): presence sweep + `live:agg` / `session:live`, lobby state,
 * MOTD stats, dashboard KPIs, vibration, counter reconcile, group start scheduling. Every tick can be run by hand (tests).
 */
@Injectable()
export class RealtimeTicker implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('Ticker');
  private timers: NodeJS.Timeout[] = [];
  private lastAgg = '';
  private readonly lastSession = new Map<string, string>();
  private readonly lastLobby = new Map<string, string>();
  private readonly lastMotd = new Map<string, number>();
  private lastKpis = '';

  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly bus: RealtimeBus, private readonly presence: PresenceService,
    private readonly live: LiveService, private readonly lobby: LobbyService, private readonly groupStart: GroupStartService, private readonly scheduler: SchedulerService,
  ) {}

  onModuleInit() { if (env.APP_ROLE === 'scheduler') this.start(); }

  /** Only the leader ticks; followers keep the timers so a takeover is instant. */
  start() {
    if (this.timers.length) return;
    const every = (ms: number, fn: () => Promise<unknown>) => this.timers.push(setInterval(() => { if (this.scheduler.isLeader()) fn().catch((e) => this.log.warn(`tick failed: ${(e as Error).message}`)); }, ms));
    every(5_000, () => this.presenceTick()); every(2_000, () => this.lobbyTick()); every(30_000, () => this.motdStatsTick());
    every(5_000, () => this.kpiTick()); every(5 * 60_000, () => this.vibrationTick()); every(60_000, () => this.reconcileTick());
    every(60_000, () => this.groupStart.schedule());
  }

  // ── presence: sweep, then publish what changed (spec: "only if changed")
  async presenceTick(now = Date.now()) {
    await this.presence.sweep(now);
    const snap = await this.live.snapshot(utcDay(now));
    const key = hash({ t: snap.total, c: snap.countries, top: snap.top, q: snap.quiet, m: snap.meditatedToday, v: snap.vibration });
    await this.redis.set(K.liveAggLast, JSON.stringify(snap), 'EX', 3600);
    // the day's highest number of people meditating together; the rollup writes it to `daily_aggregates.peak_live`
    const peakKey = `live:peak:${utcDay(now)}`;
    if ((snap.total ?? 0) > (Number(await this.redis.get(peakKey)) || 0)) await this.redis.set(peakKey, String(snap.total), 'EX', 3 * 86_400);
    let published = 0;
    if (key !== this.lastAgg) {
      this.lastAgg = key;
      await this.bus.publish('live:agg', snap);
      published++;
    }
    // per session: changed counts, plus one final zero for sessions that emptied
    const active = await this.presence.activeSessions();
    const events: { topic: string; payload: unknown }[] = [];
    for (const id of Object.keys(active)) {
      const live = await this.presence.sessionLive(id);
      const sig = `${live.people}:${live.countries}`;
      if (this.lastSession.get(id) !== sig) { this.lastSession.set(id, sig); events.push({ topic: 'session:live', payload: { sessionId: id, ...live } }); }
    }
    for (const [id, sig] of this.lastSession) {
      if (!(id in active) && sig !== '0:0') { this.lastSession.set(id, '0:0'); events.push({ topic: 'session:live', payload: { sessionId: id, people: 0, countries: 0 } }); }
    }
    await this.bus.publishMany(events);
    return { liveAgg: published, sessions: events.length };
  }

  async lobbyTick(now = Date.now()) {
    let published = 0;
    for (const date of [utcDay(now), utcDay(now, 1)]) {
      await this.lobby.sweep(date, now);
      const st = await this.lobby.state(date, now);
      const sig = hash({ w: st.waiting, c: st.countries, r: st.regions, s: st.startsAt });
      if (sig !== this.lastLobby.get(date)) { this.lastLobby.set(date, sig); await this.bus.publish('lobby:state', st); published++; }
    }
    return published;
  }

  async motdStatsTick(now = Date.now()) {
    let published = 0;
    for (const date of [utcDay(now, -1), utcDay(now), utcDay(now, 1)]) {
      const practicedToday = await this.redis.scard(K.practiced(date));
      if (this.lastMotd.get(date) !== practicedToday) { this.lastMotd.set(date, practicedToday); await this.bus.publish('motd:stats', { date, practicedToday }); published++; }
    }
    return published;
  }

  // ── dashboard
  async kpis(now = Date.now()) {
    const date = utcDay(now);
    const [snap, meds, mins, subs, founding, flagged] = await Promise.all([
      this.live.snapshot(date), this.redis.get(K.medsToday(date)), this.redis.get(K.minsToday(date)),
      this.subscriptionCounts(),
      this.db.select().from(offers).where(eq(offers.id, 'founding')).then((r) => r[0]),
      this.db.select({ n: sql<number>`count(*)::int` }).from(dedications).where(NEEDS_REVIEW).then((r) => r[0]?.n ?? 0),
    ]);
    return {
      liveNow: snap.total ?? 0, meditationsToday: Number(meds) || 0, minutesToday: Number(mins) || 0,
      payingMembers: subs.paying, inTrial: subs.trial, mrrUsd: subs.mrrUsd,
      founding: { taken: founding?.taken ?? 0, cap: founding?.cap ?? 0, open: !!founding?.open && (founding.taken < founding.cap) },
      moderationOpen: flagged, at: now,
    };
  }

  /** Active members by product (cached 30 s). Trials are not revenue yet. */
  private async subscriptionCounts() {
    const cached = await this.redis.get('dash:subs');
    if (cached) return JSON.parse(cached) as { paying: number; trial: number; mrrUsd: number };
    const rows = await this.db.select({ product: entitlements.productId, period: entitlements.periodType, n: sql<number>`count(*)::int` }).from(entitlements)
      .where(sql`${entitlements.active} and (${entitlements.expiresAt} is null or ${entitlements.expiresAt} > now())`).groupBy(entitlements.productId, entitlements.periodType);
    let paying = 0, trial = 0, mrr = 0;
    for (const r of rows) {
      if (r.period === 'trial') trial += r.n;
      else { paying += r.n; mrr += r.n * (MONTHLY_USD[r.product ?? ''] ?? 0); }
    }
    const out = { paying, trial, mrrUsd: Math.round(mrr * 100) / 100 };
    await this.redis.set('dash:subs', JSON.stringify(out), 'EX', 30);
    return out;
  }

  async kpiTick(now = Date.now()) {
    const k = await this.kpis(now);
    const { at: _at, ...rest } = k;
    void _at;
    await this.redis.set(K.dashKpisLast, JSON.stringify(k), 'EX', 3600);
    const sig = hash(rest);
    if (sig === this.lastKpis) return false;
    this.lastKpis = sig;
    await this.bus.publish('dashboard:kpis', k);
    return true;
  }

  // ── vibration + counters
  async vibrationInput(now = Date.now()) {
    const date = utcDay(now);
    const [meds, sameTime, today, group28] = await Promise.all([
      this.redis.get(K.medsToday(date)),
      this.db.execute<{ n: string }>(sql`SELECT (count(*) / 28.0)::text AS n FROM meditations WHERE counted AND started_at >= ${new Date(now - 28 * 86_400_000)} AND started_at < ${new Date(now)} AND ((started_at AT TIME ZONE 'UTC')::time) < ${new Date(now).toISOString().slice(11, 19)}::time`),
      this.db.select({ joined: motdDays.groupJoined }).from(motdDays).where(eq(motdDays.date, date)).then((r) => r[0]?.joined ?? 0),
      this.db.execute<{ n: string }>(sql`SELECT coalesce(avg(group_joined), 0)::text AS n FROM motd_days WHERE date >= ${utcDay(now, -28)} AND date < ${date}`),
    ]);
    const prev = await this.redis.get(K.vibration);
    return { meditationsToday: Number(meds) || 0, avgSameTime28d: Number(sameTime.rows[0]?.n) || 0, groupJoinedToday: today, avgGroupJoined28d: Number(group28.rows[0]?.n) || 0, previous: prev === null ? null : Number(prev) };
  }

  async vibrationTick(now = Date.now()) {
    const v = vibration(await this.vibrationInput(now));
    await this.redis.set(K.vibration, String(v));
    return v;
  }

  async reconcileTick() { return this.presence.reconcile(); }

  onApplicationShutdown() { for (const t of this.timers) clearInterval(t); this.timers = []; }
}
