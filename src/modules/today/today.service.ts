import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { AppError } from '../../common/errors';
import { compareVersions, type AppUser } from '../../common/auth';
import { env } from '../../config/env';
import { offers, programDays, programProgress, programs, sessions } from '../../db/schema';
import { CacheService } from '../../infra/cache';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K } from '../../infra/redis';
import { AuthService } from '../auth/auth.service';
import { CatalogService, sessionVisible } from '../catalog/catalog.service';
import { ConfigService, type GroupConfig, type MainConfig, type TodayConfig } from '../config/config.service';
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
    @Inject(DRIZZLE) private readonly db: DB, private readonly auth: AuthService, private readonly config: ConfigService, private readonly cache: CacheService,
    private readonly catalog: CatalogService, private readonly motd: MotdService, private readonly live: LiveService, private readonly group: GroupService,
    private readonly progress: ProgressService, private readonly entitlements: EntitlementService, private readonly programsUser: ProgramsUserService,
  ) {}

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
    const [me, main, today, group, sos, legal, founding, catalogVersion] = await Promise.all([
      this.auth.me(user.id),
      this.config.get<MainConfig>('main'), this.config.get<TodayConfig>('today'), this.config.get<GroupConfig>('group'),
      this.config.get<Record<string, unknown> & { title: string; help: unknown }>('sos'), this.config.get('legal'),
      this.founding(), this.catalog.version(),
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
      group: group.value, founding, catalogVersion,
      configVersion: [main, today, group, sos, legal].reduce((s, c) => s + c.version, 0),
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
      this.live.snapshot(date), this.group.forDate(date),
    ]);
    const freeItems = plan === 'free'
      ? await this.db.select({ id: sessions.id, title: sessions.title, youtubeId: sessions.youtubeId, durationSec: sessions.durationSec }).from(sessions)
        .where(and(sessionVisible(), eq(sessions.access, 'free'), eq(sessions.type, 'youtube'))).orderBy(desc(sessions.publishAt), asc(sessions.id))
      : [];
    const dailyMessage = plan === 'member' && today.showDailyMessage ? await this.motd.messageFor(date).then((m) => ({ date: m.date, title: m.title, type: m.type })).catch(() => null) : null;
    return { motd, live: { total: live.total, countries: live.countries, quiet: live.quiet, meditatedToday: live.meditatedToday }, group, freeItems, dailyMessage, freeHomePick: today.freeHomePick };
  }

  async today(user: AppUser, dateParam: string | undefined) {
    const date = this.checkDate(dateParam);
    const plan = (await this.entitlements.isActive(user.id)) ? 'member' : 'free';
    const [shared, tz] = await Promise.all([this.cache.getOrSet(K.today(date, plan), 30, () => this.buildShared(date, plan)), this.progress.tz(user.id)]);
    const [week, program] = await Promise.all([this.progress.week(user.id, tz), this.programCard(user.id, tz)]);
    const { freeItems, freeHomePick, ...rest } = shared;
    let freePick = null;
    if (plan === 'free' && freeItems.length) {
      // 'random' is stable per user and day (reopening the app does not reshuffle); 'newest' is the latest item
      const i = freeHomePick === 'newest' ? 0 : createHash('sha1').update(`${user.id}:${date}`).digest().readUInt32BE(0) % freeItems.length;
      const p = freeItems[i]!; freePick = { sessionId: p.id, title: p.title, youtubeId: p.youtubeId, durationSec: p.durationSec };
    }
    const body = { date, ...rest, freePick, program, progress: { minutesWeek: week.minutes, meditationsWeek: week.meditations, daysThisWeek: week.daysThisWeek } };
    return { etag: sha(body), body };
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
