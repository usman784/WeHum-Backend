import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../common/errors';
import type { AppUser } from '../../common/auth';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import { dedicationHolds, dedications, meditations, reports, sessions, userBlocks, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { RealtimeBus } from '../../infra/realtime-bus';
import { K, REDIS } from '../../infra/redis';
import { ConfigService } from '../config/config.service';
import { crisisHits, hasLink, hasProfanity } from './text-filters';

export interface ModerationRules { dailyLimit: number; autoHideReports: number; blockLinks: boolean; profanity: boolean; crisisWords: string[]; muteAfterHides: number }
export const REPORT_REASONS = ['spam', 'abusive', 'self_harm', 'personal_info', 'other'] as const;

type Row = typeof dedications.$inferSelect;
const DAY_MS = 86_400_000;

/** SQL for "waiting for a moderator": auto-flagged, or hidden by reports and not looked at yet. */
export const NEEDS_REVIEW = sql`(${dedications.status} = 'flagged' or (${dedications.status} = 'hidden' and ${dedications.moderatedAt} is null and ${dedications.reportCount} > 0))`;

/** What the app shows of a dedication. No user id: people are first name + country only. */
export const toView = (d: Row, holding = false) => ({ id: d.id, firstName: d.firstName, country: d.country, text: d.text, holdingCount: d.holdingCount, holding, createdAt: d.createdAt.toISOString() });

@Injectable()
export class CommunityService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly bus: RealtimeBus, private readonly config: ConfigService) {}

  rules() { return this.config.value<ModerationRules>('moderation'); }

  /** Open items for the sidebar badge and the dashboard. */
  async openCount(): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(dedications).where(NEEDS_REVIEW);
    return r?.n ?? 0;
  }
  async announceCount() { await this.bus.publish('moderation:count', { open: await this.openCount() }); }

  // ───────────── app: post
  async post(user: AppUser, b: { meditationId: string; text: string }) {
    const rules = await this.rules();
    const [m] = await this.db.select().from(meditations).where(and(eq(meditations.id, b.meditationId), eq(meditations.userId, user.id)));
    if (!m || !m.counted || !m.completed || !m.sessionId || Date.now() - m.endedAt.getTime() > DAY_MS) throw new AppError('MEDITATION_REQUIRED', 'Finish a meditation first');
    const text = b.text.trim().replace(/\s+/g, ' ');
    if (!text) throw new AppError('VALIDATION_FAILED', 'Write something first', { fields: [{ path: 'text', message: 'Required' }] });
    if (rules.blockLinks && hasLink(text)) throw new AppError('DEDICATION_LINKS', 'Links and handles are not allowed');
    const [u] = await this.db.select().from(users).where(eq(users.id, user.id));
    if (!u) throw new AppError('NOT_FOUND', 'User not found');

    const limitKey = K.dedLimit(user.id, m.localDate);
    const used = await this.redis.incr(limitKey);
    if (used === 1) await this.redis.expire(limitKey, 3 * 86_400);
    if (used > rules.dailyLimit) { await this.redis.decr(limitKey); throw new AppError('DEDICATION_LIMIT', `At most ${rules.dailyLimit} per day`); }

    const flags: string[] = [];
    if (rules.profanity && hasProfanity(text)) flags.push('profanity');
    const crisis = crisisHits(text, rules.crisisWords);
    if (crisis.length) flags.push('crisis');
    const status = u.mutedAt ? 'hidden' : flags.length ? 'flagged' : 'visible';
    let row: Row;
    try {
      [row] = await this.db.insert(dedications).values({
        id: uuidv7(), sessionId: m.sessionId, userId: user.id, meditationId: m.id, firstName: u.firstName?.trim() || 'Someone',
        country: u.showCountry ? u.country : null, text, status, autoFlags: flags,
      }).returning() as [Row];
    } catch (e) {
      await this.redis.decr(limitKey);
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === '23505') throw new AppError('MEDITATION_REQUIRED', 'This meditation already has a dedication');
      throw e;
    }
    if (status === 'visible') await this.bus.publish('dedication:new', { sessionId: row.sessionId, items: [toView(row)] });
    if (status === 'flagged') {
      await this.bus.publish('moderation:new', { dedication: await this.adminView(row.id), flags });
      await this.announceCount();
    }
    // a flagged or hidden post is accepted: the writer is not told why (except crisis: the app shows the help card)
    return { id: row.id, status: status === 'visible' ? 'visible' : 'pending', showHelp: crisis.length > 0, dedicationsLeftToday: Math.max(0, rules.dailyLimit - used) };
  }

  // ───────────── app: read
  async list(user: AppUser, sessionId: string, q: { cursor?: string; limit?: number }) {
    const limit = clampLimit(q.limit, 20);
    const c = decodeCursor(q.cursor);
    const conds: SQL[] = [eq(dedications.sessionId, sessionId), eq(dedications.status, 'visible'),
      sql`not exists (select 1 from ${userBlocks} b where b.blocker_id = ${user.id} and b.blocked_id = ${dedications.userId})`];
    if (c) conds.push(or(lt(dedications.createdAt, new Date(String(c.k))), and(eq(dedications.createdAt, new Date(String(c.k))), lt(dedications.id, c.id)))!);
    const rows = await this.db.select().from(dedications).where(and(...conds)).orderBy(desc(dedications.createdAt), desc(dedications.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const held = page.length ? await this.db.select({ id: dedicationHolds.dedicationId }).from(dedicationHolds).where(and(eq(dedicationHolds.userId, user.id), inArray(dedicationHolds.dedicationId, page.map((r) => r.id)))) : [];
    const mine = new Set(held.map((h) => h.id));
    return { data: page.map((r) => toView(r, mine.has(r.id))), meta: { nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.createdAt.toISOString(), page.at(-1)!.id) : null } };
  }

  /** Newest three for the session detail (not per user: cached 10 s). */
  async preview(sessionId: string) {
    const rows = await this.db.select().from(dedications).where(and(eq(dedications.sessionId, sessionId), eq(dedications.status, 'visible'))).orderBy(desc(dedications.createdAt)).limit(3);
    return rows.map((r) => toView(r));
  }

  // ───────────── app: holds, reports
  private async visible(id: string) {
    const [d] = await this.db.select().from(dedications).where(eq(dedications.id, id));
    if (!d || d.status !== 'visible') throw new AppError('NOT_FOUND', 'Dedication not found');
    return d;
  }

  async hold(user: AppUser, id: string, on: boolean) {
    const d = await this.visible(id);
    const changed = on
      ? (await this.db.insert(dedicationHolds).values({ dedicationId: id, userId: user.id }).onConflictDoNothing().returning()).length > 0
      : (await this.db.delete(dedicationHolds).where(and(eq(dedicationHolds.dedicationId, id), eq(dedicationHolds.userId, user.id))).returning()).length > 0;
    let holdingCount = d.holdingCount;
    if (changed) {
      [{ holdingCount }] = await this.db.update(dedications).set({ holdingCount: sql`greatest(0, ${dedications.holdingCount} + ${on ? 1 : -1})` }).where(eq(dedications.id, id)).returning({ holdingCount: dedications.holdingCount }) as [{ holdingCount: number }];
      await this.bus.publish('dedication:holding', { sessionId: d.sessionId, id, holdingCount });
    }
    return { id, holding: on, holdingCount };
  }

  async report(user: AppUser, id: string, b: { reason: string; block?: boolean }) {
    const [d] = await this.db.select().from(dedications).where(eq(dedications.id, id));
    if (!d || d.status === 'hidden' && d.moderatedAt) throw new AppError('NOT_FOUND', 'Dedication not found');
    if (d.userId === user.id) throw new AppError('INVALID_STATE', 'You cannot report your own dedication');
    const rules = await this.rules();
    const added = await this.db.insert(reports).values({ id: uuidv7(), dedicationId: id, reporterId: user.id, reason: b.reason }).onConflictDoNothing().returning();
    if (b.block) await this.db.insert(userBlocks).values({ blockerId: user.id, blockedId: d.userId }).onConflictDoNothing();
    if (added.length) {
      const [row] = await this.db.update(dedications).set({ reportCount: sql`${dedications.reportCount} + 1` }).where(eq(dedications.id, id)).returning();
      if (row && row.status === 'visible' && row.reportCount >= rules.autoHideReports) {
        await this.db.update(dedications).set({ status: 'hidden' }).where(and(eq(dedications.id, id), eq(dedications.status, 'visible')));
        await this.bus.publish('dedication:removed', { sessionId: row.sessionId, id });
        await this.bus.publish('moderation:new', { dedication: await this.adminView(id), flags: ['reports'] });
        await this.announceCount();
      }
    }
    return { reported: true, blocked: !!b.block };
  }

  // ───────────── admin
  /** One queue item, with the reasons people gave and the writer's state. */
  async adminView(id: string) {
    const [r] = await this.queueRows(sql`${dedications.id} = ${id}`, 1);
    return r ?? null;
  }

  private async queueRows(where: SQL, limit: number, order: SQL[] = []) {
    const rows = await this.db.select({
      d: dedications, title: sessions.title, muted: users.mutedAt,
      priority: sql<number>`(${dedications.autoFlags} @> array['crisis']::text[])::int`,
      reasons: sql<string[]>`coalesce((select array_agg(distinct r.reason) from ${reports} r where r.dedication_id = ${dedications.id}), '{}')`,
    }).from(dedications).innerJoin(sessions, eq(sessions.id, dedications.sessionId)).innerJoin(users, eq(users.id, dedications.userId))
      .where(where).orderBy(...(order.length ? order : [desc(dedications.createdAt)])).limit(limit);
    return rows.map((r) => ({
      id: r.d.id, sessionId: r.d.sessionId, sessionTitle: r.title, userId: r.d.userId, firstName: r.d.firstName, country: r.d.country, text: r.d.text,
      status: r.d.status, autoFlags: r.d.autoFlags, reportCount: r.d.reportCount, reasons: r.reasons, crisis: r.priority === 1, holdingCount: r.d.holdingCount,
      userMuted: !!r.muted, createdAt: r.d.createdAt, moderatedAt: r.d.moderatedAt, moderatedBy: r.d.moderatedBy, _p: r.priority,
    }));
  }

  async queue(q: { filter: 'review' | 'flagged' | 'hidden' | 'all'; sessionId?: string; cursor?: string; limit?: number }) {
    const limit = clampLimit(q.limit, 30);
    const conds: SQL[] = [];
    if (q.filter === 'review') conds.push(NEEDS_REVIEW);
    if (q.filter === 'flagged') conds.push(sql`${dedications.status} = 'flagged'`);
    if (q.filter === 'hidden') conds.push(sql`${dedications.status} = 'hidden'`);
    if (q.sessionId) conds.push(eq(dedications.sessionId, q.sessionId));
    const prio = sql`(${dedications.autoFlags} @> array['crisis']::text[])::int`;
    const c = decodeCursor(q.cursor);
    if (c) {
      const [p, at] = String(c.k).split('|') as [string, string];
      conds.push(sql`(${prio}, ${dedications.createdAt}, ${dedications.id}) < (${Number(p)}, ${new Date(at)}, ${c.id}::uuid)`);
    }
    const rows = await this.queueRows(conds.length ? and(...conds)! : sql`true`, limit + 1, [desc(prio), desc(dedications.createdAt), desc(dedications.id)]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(({ _p, ...r }) => r),
      meta: { nextCursor: rows.length > limit && last ? encodeCursor(`${last._p}|${last.createdAt.toISOString()}`, last.id) : null, open: await this.openCount() },
    };
  }

  /** Today's numbers for the header of the moderation screen. */
  async stats() {
    const [r] = await this.db.select({
      posts: sql<number>`count(*) filter (where ${dedications.createdAt} >= date_trunc('day', now()))::int`,
      flagged: sql<number>`count(*) filter (where ${dedications.createdAt} >= date_trunc('day', now()) and cardinality(${dedications.autoFlags}) > 0)::int`,
      hidden: sql<number>`count(*) filter (where ${dedications.moderatedAt} >= date_trunc('day', now()) and ${dedications.status} = 'hidden')::int`,
      kept: sql<number>`count(*) filter (where ${dedications.moderatedAt} >= date_trunc('day', now()) and ${dedications.status} = 'visible')::int`,
    }).from(dedications);
    return { ...r!, open: await this.openCount() };
  }

  /** Hide or keep one item. Returns the new state; the caller audits. */
  async decide(adminId: string, id: string, action: 'hide' | 'keep') {
    const rules = await this.rules();
    const [cur] = await this.db.select().from(dedications).where(eq(dedications.id, id));
    if (!cur) throw new AppError('NOT_FOUND', 'Dedication not found');
    const next = action === 'hide' ? 'hidden' : 'visible';
    const [row] = await this.db.update(dedications).set({ status: next, moderatedBy: adminId, moderatedAt: new Date(), ...(action === 'keep' && { autoFlags: [] }) }).where(eq(dedications.id, id)).returning();
    if (cur.status === 'visible' && next === 'hidden') await this.bus.publish('dedication:removed', { sessionId: cur.sessionId, id });
    if (cur.status !== 'visible' && next === 'visible') await this.bus.publish('dedication:new', { sessionId: cur.sessionId, items: [toView(row!)] });
    let autoMuted = false;
    if (action === 'hide') {
      const [h] = await this.db.select({ n: sql<number>`count(*)::int` }).from(dedications).where(and(eq(dedications.userId, cur.userId), eq(dedications.status, 'hidden'), sql`${dedications.moderatedBy} is not null`));
      if ((h?.n ?? 0) >= rules.muteAfterHides) autoMuted = !!(await this.db.update(users).set({ mutedAt: new Date() }).where(and(eq(users.id, cur.userId), sql`${users.mutedAt} is null`)).returning()).length;
    }
    return { before: cur.status, after: next, userId: cur.userId, autoMuted };
  }

  async setMuted(userId: string, muted: boolean) {
    const [u] = await this.db.update(users).set({ mutedAt: muted ? new Date() : null }).where(eq(users.id, userId)).returning({ id: users.id });
    if (!u) throw new AppError('NOT_FOUND', 'User not found');
    return { userId, muted };
  }
}
