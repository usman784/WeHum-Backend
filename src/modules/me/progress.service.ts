import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { meditations, userDailyStats, userStats, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { localDate } from '../meditations/meditation.rules';
import { addDaysIso } from '../motd/motd.service';
import { computeStreak } from './streak';

export type Period = 'week' | 'month' | 'year' | 'all';
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Monday = 0 … Sunday = 6 for a calendar date. */
const isoDow = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
export const weekStart = (d: string) => addDaysIso(d, -isoDow(d));

/** Minutes, meditations, group sits and days, read from `user_daily_stats`; the forgiving streak is computed from the same rows (Stitch, D2). */
@Injectable()
export class ProgressService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  private async rows(userId: string, from: string, to: string) {
    return this.db.select({ date: userDailyStats.localDate, minutes: userDailyStats.minutes, meditations: userDailyStats.meditations, group: userDailyStats.groupCount })
      .from(userDailyStats).where(and(eq(userDailyStats.userId, userId), gte(userDailyStats.localDate, from), lte(userDailyStats.localDate, to))).orderBy(asc(userDailyStats.localDate));
  }

  /** The current ISO week (Mon–Sun) in the user's time zone: used by Today and the progress screen. */
  async week(userId: string, tz: string, now = new Date()) {
    const today = localDate(now, tz), from = weekStart(today), to = addDaysIso(from, 6);
    const rows = await this.rows(userId, from, to);
    const by = new Map(rows.map((r) => [r.date, r]));
    return {
      from, to, today,
      minutes: rows.reduce((s, r) => s + r.minutes, 0), meditations: rows.reduce((s, r) => s + r.meditations, 0), group: rows.reduce((s, r) => s + r.group, 0),
      daysThisWeek: DOW.map((_, i) => (by.get(addDaysIso(from, i))?.meditations ?? 0) > 0),
      byDay: DOW.map((label, i) => ({ label, date: addDaysIso(from, i), minutes: by.get(addDaysIso(from, i))?.minutes ?? 0 })),
    };
  }

  async progress(userId: string, tz: string, period: Period, now = new Date()) {
    const today = localDate(now, tz), y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    const wk = await this.week(userId, tz, now);
    const [stats] = await this.db.select({ first: userStats.firstMeditationAt }).from(userStats).where(eq(userStats.userId, userId));
    let from: string, to: string;
    if (period === 'week') { from = wk.from; to = wk.to; }
    else if (period === 'month') { from = `${today.slice(0, 7)}-01`; to = `${today.slice(0, 7)}-${String(daysIn(y, m)).padStart(2, '0')}`; }
    else if (period === 'year') { from = `${y}-01-01`; to = `${y}-12-31`; }
    else { from = stats?.first ? localDate(stats.first, tz) : today; to = today; }

    const rows = period === 'week' ? null : await this.rows(userId, from, to);
    let bars: { label: string; from: string; to: string; minutes: number; current: boolean }[];
    let list: { minutes: number; meditations: number; group: number }[];
    if (period === 'week') {
      bars = wk.byDay.map((d) => ({ label: d.label, from: d.date, to: d.date, minutes: d.minutes, current: d.date === today }));
      list = [wk];
    } else if (period === 'month') {
      const n = Math.ceil(daysIn(y, m) / 7);
      bars = Array.from({ length: n }, (_, i) => {
        const f = `${today.slice(0, 7)}-${String(i * 7 + 1).padStart(2, '0')}`, t = `${today.slice(0, 7)}-${String(Math.min(daysIn(y, m), i * 7 + 7)).padStart(2, '0')}`;
        return { label: `Week ${i + 1}`, from: f, to: t, minutes: rows!.filter((r) => r.date >= f && r.date <= t).reduce((s, r) => s + r.minutes, 0), current: today >= f && today <= t };
      });
      list = rows!;
    } else {
      // one bar per calendar month, from the first active month (or January) to the current month
      const startY = Number(from.slice(0, 4)), startM = period === 'year' ? 1 : Number(from.slice(5, 7));
      bars = [];
      for (let yy = startY, mm = startM; yy < y || (yy === y && mm <= m); mm === 12 ? (yy++, mm = 1) : mm++) {
        const key = `${yy}-${String(mm).padStart(2, '0')}`;
        bars.push({ label: period === 'year' ? MONTH[mm - 1]! : `${MONTH[mm - 1]} ${yy}`, from: `${key}-01`, to: `${key}-${String(daysIn(yy, mm)).padStart(2, '0')}`,
          minutes: rows!.filter((r) => r.date.startsWith(key)).reduce((s, r) => s + r.minutes, 0), current: yy === y && mm === m });
      }
      list = rows!;
    }
    const minutes = list.reduce((s, r) => s + r.minutes, 0), meditations = list.reduce((s, r) => s + r.meditations, 0), together = list.reduce((s, r) => s + r.group, 0);
    return {
      period, from, to, minutes, meditations, together,
      average: meditations ? Math.round(minutes / meditations) : 0, // minutes per meditation
      daysMeditated: period === 'week' ? wk.daysThisWeek.filter(Boolean).length : new Set((rows ?? []).filter((r) => r.meditations > 0).map((r) => r.date)).size,
      daysThisWeek: wk.daysThisWeek, bars,
    };
  }

  async tz(userId: string) { return (await this.db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId)))[0]?.tz ?? 'UTC'; }

  /** Time zone and weekly goal in one read. */
  async profile(userId: string) {
    const [u] = await this.db.select({ tz: users.timezone, weeklyGoal: users.weeklyGoal }).from(users).where(eq(users.id, userId));
    return { tz: u?.tz ?? 'UTC', weeklyGoal: u?.weeklyGoal ?? 5 };
  }

  /** Current run, record, grace and the Monday–Sunday strip for the user's local week. */
  async streak(userId: string, tz: string, weeklyGoal: number, graceDays = 1, now = new Date()) {
    const today = localDate(now, tz);
    const rows = await this.db.select({ date: userDailyStats.localDate, minutes: userDailyStats.minutes }).from(userDailyStats)
      .where(and(eq(userDailyStats.userId, userId), gt(userDailyStats.meditations, 0))).orderBy(asc(userDailyStats.localDate));
    return computeStreak(rows.map((r) => r.date), today, { weeklyGoal, graceDays, minutesByDate: new Map(rows.map((r) => [r.date, r.minutes])) });
  }

  /** Lifetime numbers for the You tab. `hrShiftBpm` is the mean heart-rate change over sits that had a reading (null if none). */
  async lifetime(userId: string) {
    const [[st], [hr]] = await Promise.all([
      this.db.select({ minutes: userStats.minutesTotal, meditations: userStats.meditationsTotal, group: userStats.groupTotal }).from(userStats).where(eq(userStats.userId, userId)),
      this.db.select({ avg: sql<string | null>`avg(${meditations.hrDeltaBpm})` }).from(meditations).where(and(eq(meditations.userId, userId), isNotNull(meditations.hrDeltaBpm))),
    ]);
    const sits = st?.meditations ?? 0, minutes = st?.minutes ?? 0, together = st?.group ?? 0;
    return {
      sits, minutes, together, togetherPct: sits ? Math.round((together / sits) * 100) : 0,
      avgMin: sits ? Math.round((minutes / sits) * 10) / 10 : 0, hrShiftBpm: hr?.avg == null ? null : Math.round(Number(hr.avg)),
    };
  }
}
