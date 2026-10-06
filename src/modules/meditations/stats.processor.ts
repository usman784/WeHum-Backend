import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { meditations, motdDays, userDailyStats, userStats } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { applyChallengeDay } from '../coming-soon/challenge-progress';
import { CountersService } from './counters.service';

const APPLIED_TTL_SEC = 7 * 86_400;

/** Job `stats.meditation` (spec §8.2): idempotent by meditation id, so retries and duplicates never double count. */
@Injectable()
export class StatsProcessor {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly counters: CountersService) {}

  /** Returns false when this meditation was already applied (or no longer exists). */
  async apply(meditationId: string): Promise<boolean> {
    const first = await this.redis.set(K.statsDone(meditationId), '1', 'EX', APPLIED_TTL_SEC, 'NX');
    if (first !== 'OK') return false;
    let applied: typeof meditations.$inferSelect | null;
    try {
      applied = await this.db.transaction(async (tx) => {
        const [m] = await tx.select().from(meditations).where(eq(meditations.id, meditationId));
        if (!m) return null;
        if (m.counted) {
          const minutes = Math.max(1, Math.round(m.durationSec / 60));
          const group = m.kind === 'group' ? 1 : 0;
          await tx.insert(userDailyStats).values({ userId: m.userId, localDate: m.localDate, minutes, meditations: 1, groupCount: group })
            .onConflictDoUpdate({ target: [userDailyStats.userId, userDailyStats.localDate], set: {
              minutes: sql`${userDailyStats.minutes} + ${minutes}`, meditations: sql`${userDailyStats.meditations} + 1`, groupCount: sql`${userDailyStats.groupCount} + ${group}`,
            } });
          await tx.insert(userStats).values({ userId: m.userId, minutesTotal: minutes, meditationsTotal: 1, groupTotal: group, firstMeditationAt: m.startedAt, lastMeditationAt: m.endedAt })
            .onConflictDoUpdate({ target: userStats.userId, set: {
              minutesTotal: sql`${userStats.minutesTotal} + ${minutes}`, meditationsTotal: sql`${userStats.meditationsTotal} + 1`, groupTotal: sql`${userStats.groupTotal} + ${group}`,
              firstMeditationAt: sql`least(coalesce(${userStats.firstMeditationAt}, ${m.startedAt}), ${m.startedAt})`,
              lastMeditationAt: sql`greatest(coalesce(${userStats.lastMeditationAt}, ${m.endedAt}), ${m.endedAt})`, updatedAt: new Date(),
            } });
          if (m.kind === 'motd') await tx.update(motdDays).set({ soloCount: sql`${motdDays.soloCount} + 1` }).where(eq(motdDays.date, m.localDate));
          await applyChallengeDay(tx, m); // P11: open challenges move forward one day
        }
        return m;
      });
    } catch (e) {
      await this.redis.del(K.statsDone(meditationId)).catch(() => 0); // let the retry apply it
      throw e;
    }
    if (!applied) { await this.redis.del(K.statsDone(meditationId)); return false; }
    // best effort: the database part is done, so a Redis hiccup here must not make a retry count it twice
    if (applied.sessionId) await this.counters.bump(applied.sessionId, applied.completed).catch(() => null);
    return true;
  }
}
