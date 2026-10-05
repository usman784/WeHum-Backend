import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte } from 'drizzle-orm';
import { fromZonedTime } from 'date-fns-tz';
import { AppError } from '../../common/errors';
import { meditations, programDays, programProgress, programs, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { localDate } from '../meditations/meditation.rules';
import { addDaysIso } from '../motd/motd.service';

type Row = typeof programProgress.$inferSelect;

/** Programs a member walks through: start, then one day at a time. No rest days, no grace (spec §1.2). */
@Injectable()
export class ProgramsUserService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /** When the *current* day becomes available. `next_day_0700` = the next local day at 07:00 after the previous day was completed. */
  nextUnlock(lastCompletedAt: Date | null, rule: string, tz: string): Date | null {
    if (!lastCompletedAt || rule === 'immediate') return null;
    return fromZonedTime(`${addDaysIso(localDate(lastCompletedAt, tz), 1)}T07:00:00`, tz);
  }

  private async program(id: string) {
    const [p] = await this.db.select().from(programs).where(and(eq(programs.id, id), eq(programs.status, 'live')));
    if (!p) throw new AppError('NOT_FOUND', 'Program not found');
    const days = await this.db.select().from(programDays).where(eq(programDays.programId, id)).orderBy(asc(programDays.day));
    return { p, days };
  }

  private view(r: Row, total: number, rule: string, tz: string) {
    const unlock = r.completedAt ? null : this.nextUnlock(r.lastDayCompletedAt, rule, tz);
    return {
      programId: r.programId, startedAt: r.startedAt.toISOString(), currentDay: r.currentDay, completedDays: r.completedDays, days: total,
      completedAt: r.completedAt?.toISOString() ?? null, unlockAt: unlock && unlock.getTime() > Date.now() ? unlock.toISOString() : null,
    };
  }

  private async tz(userId: string) { return (await this.db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId)))[0]?.tz ?? 'UTC'; }

  /** Starting twice keeps the progress; starting a finished program begins again. */
  async start(userId: string, programId: string) {
    const { p, days } = await this.program(programId);
    if (!days.length) throw new AppError('INVALID_STATE', 'This program has no days yet');
    const [row] = await this.db.insert(programProgress).values({ userId, programId }).onConflictDoNothing().returning();
    let cur = row;
    if (!cur) {
      [cur] = await this.db.select().from(programProgress).where(and(eq(programProgress.userId, userId), eq(programProgress.programId, programId)));
      if (cur!.completedAt) {
        [cur] = await this.db.update(programProgress).set({ startedAt: new Date(), currentDay: 1, completedDays: [], lastDayCompletedAt: null, completedAt: null })
          .where(and(eq(programProgress.userId, userId), eq(programProgress.programId, programId))).returning();
      }
    }
    return this.view(cur!, days.length, p.unlockRule, await this.tz(userId));
  }

  /**
   * Completes the current day. It must be unlocked, and the member must have actually meditated that day's
   * meditation since the day became available (a counted meditation).
   */
  async complete(userId: string, programId: string, day: number) {
    const { p, days } = await this.program(programId);
    const tz = await this.tz(userId);
    const d = days.find((x) => x.day === day);
    if (!d) throw new AppError('NOT_FOUND', 'This program has no such day');
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(programProgress).where(and(eq(programProgress.userId, userId), eq(programProgress.programId, programId))).for('update');
      if (!cur) throw new AppError('INVALID_STATE', 'Start the program first');
      if (cur.completedDays.includes(day)) return this.view(cur, days.length, p.unlockRule, tz); // already done: idempotent
      if (day !== cur.currentDay) throw new AppError('INVALID_STATE', day > cur.currentDay ? 'This day is still locked' : 'This day is already behind you', { currentDay: cur.currentDay });
      const unlock = this.nextUnlock(cur.lastDayCompletedAt, p.unlockRule, tz);
      if (unlock && unlock.getTime() > Date.now()) throw new AppError('INVALID_STATE', 'This day opens tomorrow morning', { unlockAt: unlock.toISOString() });
      const since = unlock ?? cur.startedAt;
      const [done] = await tx.select({ id: meditations.id }).from(meditations)
        .where(and(eq(meditations.userId, userId), eq(meditations.sessionId, d.sessionId), eq(meditations.counted, true), gte(meditations.endedAt, since))).limit(1);
      if (!done) throw new AppError('MEDITATION_REQUIRED', 'Meditate today’s session first');
      const finished = day === days.length;
      const [row] = await tx.update(programProgress).set({
        completedDays: [...cur.completedDays, day], lastDayCompletedAt: new Date(), currentDay: finished ? day : day + 1, completedAt: finished ? new Date() : null,
      }).where(and(eq(programProgress.userId, userId), eq(programProgress.programId, programId))).returning();
      return this.view(row!, days.length, p.unlockRule, tz);
    });
  }
}
