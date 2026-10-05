import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { motdDays, sessions } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { addDaysIso, utcToday } from '../motd/motd.service';

/** Hot counters live in Redis and are written to Postgres in batches (spec §6.2): plays, completions, practicedToday. */
@Injectable()
export class CountersService {
  private readonly log = new Logger('Counters');
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis) {}

  async bump(sessionId: string, completed: boolean) {
    await this.redis.hincrby(K.countersPlays, sessionId, 1);
    if (completed) await this.redis.hincrby(K.countersCompletions, sessionId, 1);
  }

  /** Moves a hash aside atomically so increments that arrive during the flush are kept for the next one. */
  private async take(key: string): Promise<Record<string, string>> {
    const tmp = `${key}:flushing`;
    if (!(await this.redis.exists(tmp))) {
      if (!(await this.redis.exists(key))) return {};
      await this.redis.rename(key, tmp).catch(() => null);
    }
    return this.redis.hgetall(tmp);
  }

  async flush(): Promise<{ sessions: number; days: number }> {
    let touched = 0;
    for (const field of ['plays', 'completions'] as const) {
      const key = field === 'plays' ? K.countersPlays : K.countersCompletions;
      for (const [id, n] of Object.entries(await this.take(key))) {
        await this.db.update(sessions).set(field === 'plays' ? { plays: sql`${sessions.plays} + ${Number(n)}` } : { completions: sql`${sessions.completions} + ${Number(n)}` }).where(eq(sessions.id, id));
        touched++;
      }
      await this.redis.del(`${key}:flushing`);
    }
    // exact "practiced today" counts (a Redis SET of users) → motd_days, for yesterday / today / tomorrow
    const today = utcToday();
    let days = 0;
    for (const date of [addDaysIso(today, -1), today, addDaysIso(today, 1)]) {
      const n = await this.redis.scard(K.practiced(date)).catch(() => 0);
      if (n > 0) { await this.db.update(motdDays).set({ practicedToday: sql`greatest(${motdDays.practicedToday}, ${n})` }).where(eq(motdDays.date, date)); days++; }
    }
    return { sessions: touched, days };
  }
}
