import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { motdDays } from '../db/schema';
import { DRIZZLE, type DB } from '../infra/core.module';
import { RealtimeBus } from '../infra/realtime-bus';
import { K, REDIS } from '../infra/redis';
import { QUEUES, QueueService } from '../jobs/queues';
import { GroupService, slotDate } from '../modules/today/group.service';
import { metrics } from '../infra/metrics';

/** Look-ahead: group starts within this window get a delayed job (spec §8.1). */
const WINDOW_MS = 16 * 60_000;
/**
 * The job is queued to run this much *before* T0 and then waits for the exact instant. Delayed jobs are only accurate to
 * about 100 ms; a timer is accurate to about 1 ms, which is what "everyone starts together" needs.
 */
export const LEAD_MS = 1500;

@Injectable()
export class GroupStartService {
  private readonly log = new Logger('GroupStart');
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly group: GroupService, private readonly bus: RealtimeBus, private readonly queues: QueueService) {}

  /**
   * Scheduler minute tick: queue a delayed job for each group that starts within 16 minutes. The job id contains the start
   * instant, so changing the time in the CMS queues a new job (the old one notices it is stale and does nothing).
   */
  async schedule(now = Date.now()): Promise<string[]> {
    const queued: string[] = [];
    for (const date of await this.group.slots(now)) {
      const g = await this.group.forSlot(date, now);
      const startsAt = Date.parse(g.startsAt);
      if (startsAt < now - 5000 || startsAt - now > WINDOW_MS) continue;
      const jobId = `group-start-${date}-${startsAt}`;
      await this.queues.add(QUEUES.cron, 'group.start', { date, startsAt }, { jobId, delay: Math.max(0, startsAt - now - LEAD_MS), removeOnComplete: 100, removeOnFail: 100 });
      queued.push(jobId);
    }
    return queued;
  }

  /** At T0: tell everyone in the lobby, snapshot the lobby size, drop the lobby. Stale jobs (time changed) do nothing. */
  async fire(date: string, expectedStartsAt: number, now = Date.now()): Promise<boolean> {
    const g = await this.group.forSlot(date, now);
    if (Math.abs(Date.parse(g.startsAt) - expectedStartsAt) > 1000) { this.log.log(`group ${date} was rescheduled; skipping stale start`); return false; }
    const first = await this.redis.set(`group:started:${date}:${expectedStartsAt}`, '1', 'EX', 3600, 'NX');
    if (first !== 'OK') return false; // already fired (a retried job)
    const wait = expectedStartsAt - Date.now();
    if (wait > 0 && wait <= 2 * LEAD_MS) await new Promise((r) => setTimeout(r, wait)); // on the dot (a manual call far ahead of T0 does not wait)
    metrics.groupStart.set(Date.now() / 1000);
    await this.bus.publish('group:start', { date, startsAt: g.startsAt, sessionId: g.sessionId, lengthMin: g.lengthMin, mediaKey: `motd:${slotDate(date)}:${g.lengthMin}` });
    const waiting = await this.redis.zcount(K.lobby(date), now - 90_000, '+inf');
    if (date.length === 10) await this.db.update(motdDays).set({ groupJoined: waiting, updatedAt: sql`now()` }).where(eq(motdDays.date, date));
    else await this.db.update(motdDays).set({ groupJoined: sql`${motdDays.groupJoined} + ${waiting}`, updatedAt: sql`now()` }).where(eq(motdDays.date, slotDate(date)));
    return true;
  }
}
