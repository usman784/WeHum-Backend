import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors';
import { compareVersions, type AppUser } from '../../common/auth';
import { env } from '../../config/env';
import { groupIntentions, meditations, offers, programDays, programProgress, programs, sessions } from '../../db/schema';
import { LobbyService } from '../../realtime/lobby.service';
import { beltsOf } from '../../common/belts';
import { CacheService } from '../../infra/cache';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { AuthService } from '../auth/auth.service';
import { CatalogService, sessionVisible } from '../catalog/catalog.service';
import { ConfigService, type GroupConfig, type MainConfig, type SitTimesConfig, type TodayConfig } from '../config/config.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { LiveService } from '../live/live.service';
import { ProgressService } from '../me/progress.service';
import { MotdService, addDaysIso, utcToday } from '../motd/motd.service';
import { ProgramsUserService } from '../programs/programs-user.service';
import { GroupService } from './group.service';

const sha = (v: unknown) => `"${createHash('sha1').update(JSON.stringify(v)).digest('base64url').slice(0, 22)}"`;

@Injectable()
export class TodayService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly auth: AuthService, private readonly config: ConfigService, private readonly cache: CacheService,
    private readonly catalog: CatalogService, private readonly motd: MotdService, private readonly live: LiveService, private readonly group: GroupService,
    private readonly progress: ProgressService, private readonly entitlements: EntitlementService, private readonly programsUser: ProgramsUserService, private readonly lobby: LobbyService,
  ) { this.liveSvc = live; }
  private readonly liveSvc: LiveService;

  /** Founding offer counter (RevenueCat webhooks keep `taken` current, P6). */
  private founding() {
    return this.cache.getOrSet('offer:founding', 30, async () => {
      const [o] = await this.db.select().from(offers).where(eq(offers.id, 'founding'));
      const left = o ? Math.max(0, o.cap - o.taken) : 0;
      return { open: !!o && o.open && left > 0, left, cap: o?.cap ?? 0 };
    });
  }

  /**
   * One call on launch (spec §5.4). It is exempt from the version gate: an old app gets `updateRequired: true`
   * (and `maintenance: true`) in the payload instead of an error, so it can show the right screen.
   */
  async bootstrap(user: AppUser, headers: { version?: string; platform?: string }) {
    const [me, main, today, group, sos, legal, founding, catalogVersion, sitTimes, downloads, branding] = await Promise.all([
      this.auth.me(user.id),
      this.config.get<MainConfig>('main'), this.config.get<TodayConfig>('today'), this.config.get<GroupConfig>('group'),
      this.config.get<Record<string, unknown> & { title: string; help: unknown }>('sos'), this.config.get('legal'),
      this.founding(), this.catalog.version(),
      this.config.get<SitTimesConfig>('sitTimes'), this.config.get<{ quotaMb: number }>('downloads'), this.config.branding(),
    ]);
    const min = headers.platform === 'ios' || headers.platform === 'android' ? main.value.minVersion[headers.platform] : undefined;
    const plat = headers.platform === 'ios' || headers.platform === 'android' ? headers.platform : undefined;
    const latest = plat ? main.value.latestVersion?.[plat] : undefined;
    const required = !!(min && headers.version && compareVersions(headers.version, min) < 0);
    const update = {
      required,
      available: !required && !!(latest && headers.version && compareVersions(headers.version, latest) < 0),
      latest: latest ?? null,
      storeUrl: (plat && main.value.storeUrls?.[plat]) || null,
    };
    const { entitlement, createdAt: _c, email: _e, providers: _p, locale: _l, dailyMessagePush: _d, ...profile } = me;
    void _c; void _e; void _p; void _l; void _d;
    const body = {
      updateRequired: required,
      update,
      maintenance: main.value.maintenance,
      me: profile, entitlement,
      features: main.value.features,
      today: { emptyRoomThreshold: today.value.emptyRoomThreshold, freeHomePick: today.value.freeHomePick, showDailyMessage: today.value.showDailyMessage },
      group: { startUtc: group.value.startUtc, lengthMin: group.value.lengthMin, lobbyOpenMin: group.value.lobbyOpenMin, reminderMin: group.value.reminderMin, cadence: group.value.cadence ?? 'daily', hourly: group.value.hourly ?? null },
      founding, catalogVersion, branding: { appName: branding.appName, tagline: branding.tagline, logoUrl: branding.logoUrl },
      configVersion: [main, today, group, sos, legal, sitTimes, downloads, branding].reduce((s, c) => s + c.version, 0),
      sitTimes: sitTimes.value.blocks, downloads: { quotaMb: downloads.value.quotaMb },
      sos: { title: sos.value.title, help: sos.value.help },
      socket: { url: env.PUBLIC_API_URL.replace(/^http/, 'ws'), namespace: '/live' },
    };
    return { etag: sha(body), body: { serverTime: Date.now(), ...body } };
  }

  /** The date must be the user's local date, so within one day of the server's UTC date. */
  checkDate(date: string | undefined) {
    const utc = utcToday(), d = date ?? utc;
    if (d < addDaysIso(utc, -1) || d > addDaysIso(utc, 1)) throw new AppError('VALIDATION_FAILED', 'That date is too far from today', { fields: [{ path: 'date', message: 'Must be within one day of today' }] });
    return d;
  }

  /** No MOTD for the date → the most-played live premium meditation (spec §10). */
  private async fallbackMotd(date: string) {
    const [s] = await this.db.select({ id: sessions.id }).from(sessions)
      .where(and(sessionVisible(), eq(sessions.access, 'premium'), eq(sessions.isSos, false), sql`${sessions.type} <> 'youtube'`)).orderBy(desc(sessions.plays), asc(sessions.id)).limit(1);
    if (!s) return null;
    const d = await this.catalog.sessionDetail(s.id, await this.catalog.version());
    return { date, sessionId: d.id, title: d.title, teacher: d.teacher?.name ?? null, theme: d.theme?.name ?? null, cover: d.cover, lengths: [] as number[], access: 'premium' as const, practicedToday: 0, fallback: true };
  }

  private async buildShared(date: string, plan: 'free' | 'member') {
    const [today, motd, live, group] = await Promise.all([
      this.config.value<TodayConfig>('today'),
      this.motd.forDate(date).then((m) => ({ ...m, fallback: false })).catch((e) => { if (e instanceof AppError && e.code === 'NOT_FOUND') return this.fallbackMotd(date); throw e; }),
      this.live.snapshot(date), this.group.forToday(date),
    ]);
    const freeItems = plan === 'free'
      ? await this.db.select({ id: sessions.id, title: sessions.title, youtubeId: sessions.youtubeId, durationSec: sessions.durationSec }).from(sessions)
        .where(and(sessionVisible(), eq(sessions.access, 'free'), eq(sessions.type, 'youtube'))).orderBy(desc(sessions.publishAt), asc(sessions.id))
      : [];
    const dailyMessage = plan === 'member' && today.showDailyMessage ? await this.motd.messageFor(date).then((m) => ({ date: m.date, title: m.title, type: m.type, durationSec: m.durationSec ?? null })).catch(() => null) : null;
    const silence = await this.liveSvc.silence().catch(() => null);
    const global = await this.group.nextGlobal();
    return {
      motd, live: { total: live.total, countries: live.countries, quiet: live.quiet, meditatedToday: live.meditatedToday }, group, global, freeItems, dailyMessage, freeHomePick: today.freeHomePick,
      presence: { belts: live.belts ?? beltsOf(live.top), silenceNow: silence?.people ?? 0 },
    };
  }

  async today(user: AppUser, dateParam: string | undefined) {
    const date = this.checkDate(dateParam);
    const plan = (await this.entitlements.isActive(user.id)) ? 'member' : 'free';
    const [shared, profile, main] = await Promise.all([this.cache.getOrSet(K.today(date, plan), 30, () => this.buildShared(date, plan)), this.progress.profile(user.id), this.config.value<MainConfig>('main')]);
    const tz = profile.tz;
    const [week, program, streak, continueLast] = await Promise.all([
      this.progress.week(user.id, tz), this.programCard(user.id, tz),
      main.features?.streaks === false ? null : this.progress.streak(user.id, tz, profile.weeklyGoal),
      this.continueLast(user.id),
    ]);
    const { freeItems, freeHomePick, ...rest } = shared;
    let freePick = null;
    if (plan === 'free' && freeItems.length) {
      // 'random' is stable per user and day (reopening the app does not reshuffle); 'newest' is the latest item
      const i = freeHomePick === 'newest' ? 0 : createHash('sha1').update(`${user.id}:${date}`).digest().readUInt32BE(0) % freeItems.length;
      const p = freeItems[i]!; freePick = { sessionId: p.id, title: p.title, youtubeId: p.youtubeId, durationSec: p.durationSec };
    }
    const body = { date, ...rest, freePick, program, continueLast, streak, progress: { minutesWeek: week.minutes, meditationsWeek: week.meditations, daysThisWeek: week.daysThisWeek } };
    return { etag: sha(body), body };
  }

  /** `GET /v1/group/next`: the sit itself plus what the lobby and countdown screens show around it. */
  async nextGroup(user: AppUser, kind: 'group' | 'global' = 'group') {
    const [g, details] = await Promise.all([kind === 'global' ? this.group.nextGlobal() : this.group.next(), this.group.details()]);
    if (!g) throw new AppError('NOT_FOUND', 'No Global meditation is planned');
    const [lobby, mine] = await Promise.all([
      this.lobby.state(g.date),
      this.db.select({ intention: groupIntentions.intention }).from(groupIntentions).where(and(eq(groupIntentions.userId, user.id), eq(groupIntentions.startsAt, new Date(g.startsAt)))).then((r) => r[0]?.intention ?? null),
    ]);
    return { ...g, ...details, waitingByBelt: lobby.byBelt, intentionCounts: lobby.intentions, myIntention: mine };
  }

  async setIntention(user: AppUser, slot: string, intention: string) {
    const [details, g] = await Promise.all([this.group.details(), this.group.forSlot(slot)]);
    if (!details.intentions.includes(intention)) throw new AppError('VALIDATION_FAILED', 'Pick one of the offered intentions', { fields: [{ path: 'intention', message: 'Not an option' }] });
    const startsAt = new Date(g.startsAt);
    const [prev] = await this.db.select({ intention: groupIntentions.intention }).from(groupIntentions).where(and(eq(groupIntentions.userId, user.id), eq(groupIntentions.startsAt, startsAt)));
    await this.db.insert(groupIntentions).values({ userId: user.id, startsAt, intention })
      .onConflictDoUpdate({ target: [groupIntentions.userId, groupIntentions.startsAt], set: { intention } });
    if (prev?.intention !== intention) {
      const key = K.lobbyIntentions(slot);
      const m = this.redis.multi().hincrby(key, intention, 1).expire(key, 2 * 86_400);
      if (prev) m.hincrby(key, prev.intention, -1);
      await m.exec().catch(() => null);
    }
    return { slot, startsAt: g.startsAt, intention };
  }

  /** The newest sit left unfinished within the last 3 days (catalog meditations only): "Continue last · 6 min left". */
  private async continueLast(userId: string) {
    const [r] = await this.db.select({ m: meditations, title: sessions.title, total: sessions.durationSec }).from(meditations)
      .innerJoin(sessions, eq(sessions.id, meditations.sessionId))
      .where(and(eq(meditations.userId, userId), eq(meditations.completed, false), sql`${meditations.startedAt} > now() - interval '3 days'`, sql`${meditations.durationSec} >= 30`))
      .orderBy(desc(meditations.startedAt)).limit(1);
    if (!r || r.total <= r.m.durationSec + 30) return null;
    // a later completed sit of the same meditation closes the open one
    const [done] = await this.db.select({ id: meditations.id }).from(meditations)
      .where(and(eq(meditations.userId, userId), eq(meditations.sessionId, r.m.sessionId!), eq(meditations.completed, true), sql`${meditations.startedAt} > ${r.m.startedAt}`)).limit(1);
    if (done) return null;
    return { sessionId: r.m.sessionId, title: r.title, positionSec: r.m.durationSec, leftSec: r.total - r.m.durationSec, kind: r.m.kind };
  }

  /** The program the user is in the middle of (most recently started). */
  private async programCard(userId: string, tz: string) {
    const [r] = await this.db.select({ id: programs.id, title: programs.title, rule: programs.unlockRule, pp: programProgress, days: sql<number>`(select count(*)::int from ${programDays} where ${programDays.programId} = ${programs.id})` })
      .from(programProgress).innerJoin(programs, eq(programs.id, programProgress.programId))
      .where(and(eq(programProgress.userId, userId), sql`${programProgress.completedAt} is null`, eq(programs.status, 'live'))).orderBy(desc(programProgress.startedAt)).limit(1);
    if (!r) return null;
    const unlockAt = this.programsUser.nextUnlock(r.pp.lastDayCompletedAt, r.rule, tz);
    return { id: r.id, title: r.title, day: r.pp.currentDay, days: r.days, unlockAt: unlockAt && unlockAt.getTime() > Date.now() ? unlockAt.toISOString() : null };
  }
}
