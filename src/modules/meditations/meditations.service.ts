import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import type { AppUser } from '../../common/auth';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import { meditations, sessions, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { QUEUES, QueueService } from '../../jobs/queues';
import { ConfigService } from '../config/config.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { LiveService } from '../live/live.service';
import { isCounted, localDate, validTimes } from './meditation.rules';

const iso = z.string().datetime({ offset: true });
export const MeditationDto = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid().nullish(),
  recipeId: z.string().uuid().nullish(),
  kind: z.enum(['motd', 'group', 'solo', 'silence', 'custom', 'program', 'sos', 'free']),
  lengthVariant: z.union([z.literal(10), z.literal(30), z.literal(45)]).nullish(),
  startedAt: iso, endedAt: iso,
  durationSec: z.number().int().min(1).max(4 * 3600),
  completed: z.boolean().default(false),
  offline: z.boolean().default(false),
}).strict();
export type MeditationInput = z.infer<typeof MeditationDto>;
export const BatchDto = z.object({ items: z.array(MeditationDto).min(1).max(100) }).strict();

const TTL_3D = 3 * 86_400;

@Injectable()
export class MeditationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly queues: QueueService,
    private readonly live: LiveService, private readonly entitlements: EntitlementService, private readonly config: ConfigService,
  ) {}

  /**
   * Records one meditation (spec §5.4). Idempotent by the client id; the server decides `counted` and `localDate`
   * (the user's current time zone at the start time). Stats are applied asynchronously by the stats job.
   */
  async record(user: AppUser, b: MeditationInput) {
    const startedAt = new Date(b.startedAt), endedAt = new Date(b.endedAt);
    if (!validTimes(startedAt, endedAt)) throw new AppError('INVALID_STATE', 'The start and end times are not valid');
    if (b.durationSec > (endedAt.getTime() - startedAt.getTime()) / 1000 + 60) throw new AppError('INVALID_STATE', 'The duration is longer than the time between start and end');

    const [u] = await this.db.select({ tz: users.timezone, country: users.country, deletedAt: users.deletedAt, isGuest: users.isGuest }).from(users).where(eq(users.id, user.id));
    if (!u || u.deletedAt) throw new AppError('GONE', 'Account no longer exists');
    // a session that has since been deleted must not make an offline meditation fail
    const sess = b.sessionId ? (await this.db.select({ id: sessions.id, durationSec: sessions.durationSec }).from(sessions).where(eq(sessions.id, b.sessionId)))[0] : undefined;
    const counted = isCounted(b.durationSec, sess?.durationSec);
    const date = localDate(startedAt, u.tz);

    const [row] = await this.db.insert(meditations).values({
      id: b.id, userId: user.id, sessionId: sess?.id ?? null, recipeId: b.recipeId ?? null, kind: b.kind, lengthVariant: b.lengthVariant ?? null,
      startedAt, endedAt, durationSec: b.durationSec, counted, completed: b.completed, offline: b.offline, localDate: date, country: u.country,
    }).onConflictDoNothing({ target: meditations.id }).returning();

    let created = true, out = row;
    if (!row) {
      created = false;
      [out] = await this.db.select().from(meditations).where(eq(meditations.id, b.id));
      if (out!.userId !== user.id) throw new AppError('ALREADY_EXISTS', 'This id is already used');
    } else {
      await this.afterInsert(user.id, date, counted, b.durationSec);
      await this.queues.add(QUEUES.stats, 'meditation', { meditationId: b.id }, { jobId: `stats-${b.id}`, attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
    }
    return { created, result: await this.result(user, out!, u.isGuest) };
  }

  /** Redis hot counters used by the live line and the MOTD card; both fail soft. */
  private async afterInsert(userId: string, date: string, counted: boolean, durationSec: number) {
    if (!counted) return;
    try {
      await this.redis.multi().sadd(K.practiced(date), userId).expire(K.practiced(date), TTL_3D).incr(K.medsToday(date)).expire(K.medsToday(date), TTL_3D)
        .incrby(K.minsToday(date), Math.max(1, Math.round(durationSec / 60))).expire(K.minsToday(date), TTL_3D).exec();
    } catch { /* counts are rebuilt from Postgres by the rollup; never fail a recording because of Redis */ }
  }

  /** `isGuest` comes from the database: the token claim is stale for up to 15 minutes after the user links an account. */
  private async result(user: AppUser, m: typeof meditations.$inferSelect, isGuest: boolean) {
    const [snap, member, mod] = await Promise.all([this.live.snapshot(m.localDate), this.entitlements.isActive(user.id), this.config.value<{ dailyLimit: number }>('moderation')]);
    const used = Number(await this.redis.get(K.dedLimit(user.id, m.localDate)).catch(() => 0)) || 0;
    return {
      id: m.id, counted: m.counted, localDate: m.localDate,
      canDedicate: m.counted && m.completed && !!m.sessionId && member && !isGuest && used < mod.dailyLimit,
      dedicationsLeftToday: Math.max(0, mod.dailyLimit - used),
      together: { people: snap.total ?? 0, countries: snap.countries ?? 0 },
    };
  }

  /** Offline sync (≤ 100): one result per item, a bad item never blocks the others. */
  async batch(user: AppUser, items: MeditationInput[]) {
    const results: ({ id: string; status: 'created' | 'duplicate' } & Awaited<ReturnType<MeditationsService['result']>> | { id: string; status: 'rejected'; error: { code: string; message: string } })[] = [];
    for (const it of items) {
      try {
        const r = await this.record(user, it);
        results.push({ status: r.created ? 'created' : 'duplicate', ...r.result });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ id: it.id, status: 'rejected', error: { code: e.code, message: e.message } });
      }
    }
    return { results, created: results.filter((r) => r.status === 'created').length, duplicates: results.filter((r) => r.status === 'duplicate').length, rejected: results.filter((r) => r.status === 'rejected').length };
  }

  async history(userId: string, q: { cursor?: string; limit?: number }) {
    const limit = clampLimit(q.limit, 20);
    const c = decodeCursor(q.cursor);
    const cond = c ? or(lt(meditations.startedAt, new Date(String(c.k))), and(eq(meditations.startedAt, new Date(String(c.k))), lt(meditations.id, c.id))) : undefined;
    const rows = await this.db.select({ m: meditations, title: sessions.title }).from(meditations).leftJoin(sessions, eq(sessions.id, meditations.sessionId))
      .where(and(eq(meditations.userId, userId), cond)).orderBy(desc(meditations.startedAt), desc(meditations.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      data: page.map(({ m, title }) => ({
        id: m.id, sessionId: m.sessionId, sessionTitle: title, kind: m.kind, lengthVariant: m.lengthVariant, startedAt: m.startedAt.toISOString(), endedAt: m.endedAt.toISOString(),
        durationSec: m.durationSec, counted: m.counted, completed: m.completed, localDate: m.localDate,
      })),
      meta: { nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.m.startedAt.toISOString(), page.at(-1)!.m.id) : null },
    };
  }
}
