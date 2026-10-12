import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, lt, lte } from 'drizzle-orm';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import { dailyMessages, motdDays, motdVariants, savedMessages, sessions, teachers, themes } from '../../db/schema';
import { CdnSigner } from '../../infra/cdn';
import { CacheService } from '../../infra/cache';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { ConfigService, type GroupConfig } from '../config/config.service';
import { coverMap, toCover } from '../catalog/catalog.mapper';

export const utcToday = () => new Date().toISOString().slice(0, 10);
export const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class MotdService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    private readonly cdn: CdnSigner,
  ) {}

  /** MOTD for a date (spec §5.4). Cached 60 s; the CMS publish path deletes `motd:{date}`. Metadata is public, the audio is premium. */
  async forDate(date: string) {
    const base = await this.cache.getOrSet(`motd:${date}`, 60, async () => {
      const [row] = await this.db.select({ d: motdDays, s: sessions }).from(motdDays).innerJoin(sessions, eq(sessions.id, motdDays.sessionId)).where(eq(motdDays.date, date));
      if (!row) return null;
      const [variants, teacher, theme, covers, group] = await Promise.all([
        this.db.select({ len: motdVariants.lengthMin }).from(motdVariants).where(eq(motdVariants.date, date)).orderBy(asc(motdVariants.lengthMin)),
        row.s.teacherId ? this.db.select({ name: teachers.name }).from(teachers).where(eq(teachers.id, row.s.teacherId)).then((r) => r[0]) : undefined,
        row.s.themeId ? this.db.select({ name: themes.name }).from(themes).where(eq(themes.id, row.s.themeId)).then((r) => r[0]) : undefined,
        coverMap(this.db, [row.s.coverMediaId]),
        this.config.value<GroupConfig>('group'),
      ]);
      return {
        date,
        sessionId: row.s.id,
        title: row.s.title,
        teacher: teacher?.name ?? null,
        theme: theme?.name ?? null,
        cover: toCover(this.cdn, covers, row.s.coverMediaId, row.s.coverUrl),
        lengths: variants.map((v) => v.len),
        access: 'premium' as const,
        group: { startUtc: row.d.groupStartUtc ?? group.startUtc, lengthMin: row.d.groupLengthMin ?? group.lengthMin },
        practicedBase: row.d.practicedToday,
      };
    });
    if (!base) throw new AppError('NOT_FOUND', 'No meditation of the day for this date');
    const { practicedBase, ...rest } = base;
    return { ...rest, practicedToday: Math.max(practicedBase, await this.redis.scard(K.practiced(date)).catch(() => 0)) };
  }

  /** How many people meditated this session today. Only the MOTD has a counter until P4 wires per-session counters. */
  async practicedTodaySession(sessionId: string): Promise<number> {
    const today = utcToday();
    const m = await this.forDate(today).catch(() => null);
    return m?.sessionId === sessionId ? m.practicedToday : 0;
  }

  // ── Daily messages. Free messages (`access = free`) are open to everyone, premium ones to members.
  // Future-dated messages are never served beyond "tomorrow" (timezone slack).
  private toMessage(m: typeof dailyMessages.$inferSelect, imageKey?: string | null, locked = false) {
    return {
      date: m.date, type: m.type, title: m.title, text: locked ? null : m.text, durationSec: m.durationSec, themeTag: m.themeTag, access: m.access, locked,
      image: imageKey ? { url: this.cdn.publicUrl(imageKey) } : null, hasMedia: !!m.mediaId, hasVideo: !!m.videoMediaId,
    };
  }

  private async imageKey(m: typeof dailyMessages.$inferSelect) {
    if (!m.imageMediaId) return null;
    return (await coverMap(this.db, [m.imageMediaId])).get(m.imageMediaId)?.key ?? null;
  }

  /** Message for the date, falling back to the latest earlier one. `viewer` decides what a free user may open. */
  async messageFor(date: string, viewer?: { userId: string; member: boolean }) {
    const max = addDaysIso(utcToday(), 1);
    const d = date > max ? max : date;
    const [m] = await this.db.select().from(dailyMessages).where(and(eq(dailyMessages.status, 'live'), lte(dailyMessages.date, d))).orderBy(desc(dailyMessages.date)).limit(1);
    if (!m) throw new AppError('NOT_FOUND', 'No daily message yet');
    const locked = !!viewer && !viewer.member && m.access === 'premium';
    if (locked) throw new AppError('PREMIUM_REQUIRED', 'A WeHum membership is needed for this daily message');
    const base = this.toMessage(m, await this.imageKey(m));
    if (!viewer) return base;
    const [saved, listeners, week] = await Promise.all([
      this.db.select({ d: savedMessages.date }).from(savedMessages).where(and(eq(savedMessages.userId, viewer.userId), eq(savedMessages.date, m.date))).then((r) => r.length > 0),
      this.redis.scard(`dm:${m.date}:listeners`).catch(() => 0),
      this.week(m.date, viewer.member),
    ]);
    return { ...base, transcript: m.transcript, saved, listenersToday: listeners, week };
  }

  /** The messages of the ISO week of `date` (past and today as items, later days as `upcoming` without a title). */
  private async week(date: string, member: boolean) {
    const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    const from = addDaysIso(date, -dow), to = addDaysIso(from, 6);
    const rows = await this.db.select().from(dailyMessages).where(and(gte(dailyMessages.date, from), lte(dailyMessages.date, to), eq(dailyMessages.status, 'live'))).orderBy(asc(dailyMessages.date));
    const today = utcToday();
    return rows.map((m) => m.date > today
      ? { date: m.date, title: null, durationSec: null, access: m.access, state: 'upcoming' as const, locked: true }
      : { date: m.date, title: m.title, durationSec: m.durationSec, access: m.access, state: m.date === date ? ('today' as const) : ('available' as const), locked: !member && m.access === 'premium' });
  }

  /** A member or free user finished a message: counted once per person and day (a Redis set; "N practitioners completed today"). */
  async markListened(date: string, userId: string) {
    const key = `dm:${date}:listeners`;
    await this.redis.multi().sadd(key, userId).expire(key, 3 * 86_400).exec();
    return { listeners: await this.redis.scard(key) };
  }

  async save(userId: string, date: string, on: boolean) {
    const [m] = await this.db.select({ d: dailyMessages.date }).from(dailyMessages).where(and(eq(dailyMessages.date, date), eq(dailyMessages.status, 'live')));
    if (!m) throw new AppError('NOT_FOUND', 'No daily message for this date');
    if (on) await this.db.insert(savedMessages).values({ userId, date }).onConflictDoNothing();
    else await this.db.delete(savedMessages).where(and(eq(savedMessages.userId, userId), eq(savedMessages.date, date)));
    return { date, saved: on };
  }

  async archive(p: { q?: string; theme?: string; cursor?: string; limit?: number }, member = true) {
    const limit = clampLimit(p.limit);
    const conds = [eq(dailyMessages.status, 'live'), lte(dailyMessages.date, addDaysIso(utcToday(), 1))];
    const c = decodeCursor(p.cursor);
    if (c) conds.push(lt(dailyMessages.date, String(c.k)));
    if (p.theme) conds.push(eq(dailyMessages.themeTag, p.theme));
    if (p.q) conds.push(ilike(dailyMessages.title, `%${p.q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`));
    const rows = await this.db.select().from(dailyMessages).where(and(...conds)).orderBy(desc(dailyMessages.date)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const covers = await coverMap(this.db, page.map((m) => m.imageMediaId));
    return {
      data: page.map((m) => this.toMessage(m, m.imageMediaId ? covers.get(m.imageMediaId)?.key : null, !member && m.access === 'premium')),
      meta: { nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.date, page.at(-1)!.date) : null },
    };
  }
}
