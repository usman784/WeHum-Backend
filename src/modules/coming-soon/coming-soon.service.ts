import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import type { AppUser } from '../../common/auth';
import { AppError } from '../../common/errors';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import {
  breathPatterns, challengeParticipants, challenges, dedications, gratitudePosts, gratitudeReports, sessions, userBlocks, userBreathPatterns,
  userDailyStats, userMilestones, userStats, users,
} from '../../db/schema';
import { CdnSigner } from '../../infra/cdn';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { RealtimeBus } from '../../infra/realtime-bus';
import { REDIS } from '../../infra/redis';
import { coverMap, toSessionSummary } from '../catalog/catalog.mapper';
import { sessionVisible } from '../catalog/catalog.service';
import type { ModerationRules } from '../community/community.service';
import { crisisHits, hasLink, hasProfanity } from '../community/text-filters';
import { ConfigService, type MainConfig } from '../config/config.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { milestones, MILESTONES, type Feature, type MilestoneStats } from './rules';

export type GratitudeKind = 'gratitude' | 'affirmation' | 'love';
type Post = typeof gratitudePosts.$inferSelect;
const DAY_S = 86_400;

/** What the app shows of a gratitude post: first name + country, never the user id. */
export const postView = (p: Post) => ({ id: p.id, kind: p.kind, firstName: p.firstName, country: p.country, text: p.text, createdAt: p.createdAt.toISOString() });
export const GRATITUDE_REVIEW = sql`(${gratitudePosts.status} = 'flagged' or (${gratitudePosts.status} = 'hidden' and ${gratitudePosts.moderatedAt} is null and ${gratitudePosts.reportCount} > 0))`;
export const patternView = (p: typeof breathPatterns.$inferSelect | typeof userBreathPatterns.$inferSelect) => ({
  id: p.id, name: p.name, subtitle: 'subtitle' in p ? p.subtitle : null, inhaleSec: p.inhaleSec, hold1Sec: p.hold1Sec, exhaleSec: p.exhaleSec, hold2Sec: p.hold2Sec, rounds: p.rounds,
});

/**
 * P11 "coming soon" features for the app: challenge participation, the gratitude feed, breathwork and milestones.
 * Each one answers only while its flag in Settings → App & releases is on (`404 FEATURE_OFF` otherwise).
 */
@Injectable()
export class ComingSoonService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly config: ConfigService,
    private readonly bus: RealtimeBus, private readonly entitlements: EntitlementService, private readonly cdn: CdnSigner,
  ) {}

  async require(feature: Feature) {
    const main = await this.config.value<MainConfig>('main');
    if (!main.features?.[feature]) throw new AppError('FEATURE_OFF', 'This is coming soon');
  }

  // ───────────── challenges
  async challenges(user: AppUser) {
    await this.require('challenges');
    const [list, mine, counts] = await Promise.all([
      this.db.select().from(challenges).where(and(eq(challenges.status, 'live'), or(sql`${challenges.startsAt} is null`, sql`${challenges.startsAt} <= now()`))).orderBy(asc(challenges.days), asc(challenges.name)),
      this.db.select().from(challengeParticipants).where(eq(challengeParticipants.userId, user.id)),
      this.db.select({ id: challengeParticipants.challengeId, n: sql<number>`count(*) filter (where ${challengeParticipants.finishedAt} is null)::int` }).from(challengeParticipants).groupBy(challengeParticipants.challengeId),
    ]);
    const byId = new Map(mine.map((p) => [p.challengeId, p]));
    const active = new Map(counts.map((c) => [c.id, c.n]));
    const covers = await coverMap(this.db, list.map((c) => c.coverMediaId));
    const view = (c: (typeof list)[number]) => {
      const p = byId.get(c.id);
      return {
        id: c.id, name: c.name, days: c.days, counts: c.counts, minMinutes: c.minMinutes, membersOnly: c.membersOnly,
        cover: c.coverMediaId && covers.get(c.coverMediaId) ? { url: this.cdn.publicUrl(covers.get(c.coverMediaId)!.key), blurhash: covers.get(c.coverMediaId)!.blurhash } : null,
        peopleInIt: active.get(c.id) ?? 0,
        me: p ? { joinedAt: p.joinedAt.toISOString(), completedDays: p.completedDays, lastDay: p.lastDay, finishedAt: p.finishedAt?.toISOString() ?? null } : null,
      };
    };
    const all = list.map(view);
    return {
      inProgress: all.filter((c) => c.me && !c.me.finishedAt),
      available: all.filter((c) => !c.me || c.me.finishedAt),
      finished: all.filter((c) => c.me?.finishedAt).map((c) => ({ id: c.id, name: c.name, days: c.days, finishedAt: c.me!.finishedAt })),
    };
  }

  async join(user: AppUser, id: string) {
    await this.require('challenges');
    const [c] = await this.db.select().from(challenges).where(eq(challenges.id, id));
    if (!c || c.status !== 'live') throw new AppError('NOT_FOUND', 'Challenge not found');
    if (c.membersOnly && !(await this.entitlements.isActive(user.id))) throw new AppError('PREMIUM_REQUIRED', 'Challenges are for members');
    // starting again after finishing (or after leaving) begins at day 0
    await this.db.insert(challengeParticipants).values({ challengeId: id, userId: user.id })
      .onConflictDoUpdate({ target: [challengeParticipants.challengeId, challengeParticipants.userId], set: { joinedAt: new Date(), completedDays: 0, lastDay: null, finishedAt: null } });
    return { joined: true };
  }

  async leave(user: AppUser, id: string) {
    await this.require('challenges');
    await this.db.delete(challengeParticipants).where(and(eq(challengeParticipants.challengeId, id), eq(challengeParticipants.userId, user.id), sql`${challengeParticipants.finishedAt} is null`));
    return { joined: false };
  }

  // ───────────── gratitude feed
  async feed(user: AppUser, q: { kind: GratitudeKind; cursor?: string; limit?: number }) {
    await this.require('gratitude');
    const limit = clampLimit(q.limit, 20);
    const conds: SQL[] = [eq(gratitudePosts.kind, q.kind), eq(gratitudePosts.status, 'visible'),
      sql`not exists (select 1 from ${userBlocks} b where b.blocker_id = ${user.id} and b.blocked_id = ${gratitudePosts.userId})`];
    const c = decodeCursor(q.cursor);
    if (c) conds.push(or(lt(gratitudePosts.createdAt, new Date(String(c.k))), and(eq(gratitudePosts.createdAt, new Date(String(c.k))), lt(gratitudePosts.id, c.id)))!);
    const rows = await this.db.select().from(gratitudePosts).where(and(...conds)).orderBy(desc(gratitudePosts.createdAt), desc(gratitudePosts.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { data: page.map(postView), meta: { nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.createdAt.toISOString(), page.at(-1)!.id) : null } };
  }

  /** Same rules as dedications (moderation settings): members with an account, daily limit, no links, filters, mute. */
  async share(user: AppUser, b: { kind: GratitudeKind; text: string }) {
    await this.require('gratitude');
    const rules = await this.config.value<ModerationRules>('moderation');
    const text = b.text.trim().replace(/\s+/g, ' ');
    if (!text) throw new AppError('VALIDATION_FAILED', 'Write something first', { fields: [{ path: 'text', message: 'Required' }] });
    if (text.length > 200) throw new AppError('VALIDATION_FAILED', 'At most 200 characters', { fields: [{ path: 'text', message: 'At most 200 characters' }] });
    if (rules.blockLinks && hasLink(text)) throw new AppError('DEDICATION_LINKS', 'Links and handles are not allowed');
    const [u] = await this.db.select().from(users).where(eq(users.id, user.id));
    if (!u) throw new AppError('GONE', 'Account no longer exists');
    const key = `grat:limit:${user.id}:${new Date().toISOString().slice(0, 10)}`;
    const used = await this.redis.incr(key);
    if (used === 1) await this.redis.expire(key, 2 * DAY_S);
    if (used > rules.dailyLimit) { await this.redis.decr(key); throw new AppError('DEDICATION_LIMIT', `At most ${rules.dailyLimit} per day`); }
    const flags: string[] = [];
    if (rules.profanity && hasProfanity(text)) flags.push('profanity');
    const crisis = crisisHits(text, rules.crisisWords);
    if (crisis.length) flags.push('crisis');
    const status = u.mutedAt ? 'hidden' : flags.length ? 'flagged' : 'visible';
    const [row] = await this.db.insert(gratitudePosts).values({
      id: uuidv7(), userId: user.id, kind: b.kind, firstName: u.firstName?.trim() || 'Someone', country: u.showCountry ? u.country : null, text, status, autoFlags: flags,
    }).returning();
    if (status === 'visible') await this.bus.publish('gratitude:new', { kind: row!.kind, item: postView(row!) });
    if (status === 'flagged') await this.bus.publish('moderation:new', { gratitude: { id: row!.id }, flags });
    return { id: row!.id, status: status === 'visible' ? 'visible' : 'pending', showHelp: crisis.length > 0, postsLeftToday: Math.max(0, rules.dailyLimit - used) };
  }

  async reportPost(user: AppUser, id: string, b: { reason: string; block?: boolean }) {
    await this.require('gratitude');
    const [p] = await this.db.select().from(gratitudePosts).where(eq(gratitudePosts.id, id));
    if (!p || (p.status === 'hidden' && p.moderatedAt)) throw new AppError('NOT_FOUND', 'Post not found');
    if (p.userId === user.id) throw new AppError('INVALID_STATE', 'You cannot report your own post');
    const rules = await this.config.value<ModerationRules>('moderation');
    const added = await this.db.insert(gratitudeReports).values({ postId: id, reporterId: user.id, reason: b.reason }).onConflictDoNothing().returning();
    if (b.block) await this.db.insert(userBlocks).values({ blockerId: user.id, blockedId: p.userId }).onConflictDoNothing();
    if (added.length) {
      const [row] = await this.db.update(gratitudePosts).set({ reportCount: sql`${gratitudePosts.reportCount} + 1` }).where(eq(gratitudePosts.id, id)).returning();
      if (row && row.status === 'visible' && row.reportCount >= rules.autoHideReports) {
        await this.db.update(gratitudePosts).set({ status: 'hidden' }).where(and(eq(gratitudePosts.id, id), eq(gratitudePosts.status, 'visible')));
        await this.bus.publish('gratitude:removed', { kind: row.kind, id });
        await this.bus.publish('moderation:new', { gratitude: { id }, flags: ['reports'] });
      }
    }
    return { reported: true, blocked: !!b.block };
  }

  // ───────────── breathwork
  async breathwork() {
    await this.require('breathwork');
    const [patterns, cfg] = await Promise.all([
      this.db.select().from(breathPatterns).where(eq(breathPatterns.status, 'live')).orderBy(asc(breathPatterns.sort), asc(breathPatterns.name)),
      this.config.value<{ lessons: string[] }>('breathwork'),
    ]);
    const ids = cfg.lessons ?? [];
    const rows = ids.length ? await this.db.select().from(sessions).where(and(inArray(sessions.id, ids), sessionVisible())) : [];
    const covers = await coverMap(this.db, rows.map((r) => r.coverMediaId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lessons = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r, i) => ({ lesson: i + 1, session: toSessionSummary(r, this.cdn, covers) }));
    return { templates: patterns.map(patternView), lessons };
  }

  async myPatterns(user: AppUser) {
    await this.require('breathwork');
    const rows = await this.db.select().from(userBreathPatterns).where(eq(userBreathPatterns.userId, user.id)).orderBy(desc(userBreathPatterns.createdAt));
    return rows.map(patternView);
  }

  async savePattern(user: AppUser, b: { name: string; inhaleSec: number; hold1Sec: number; exhaleSec: number; hold2Sec: number; rounds: number }) {
    await this.require('breathwork');
    const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(userBreathPatterns).where(eq(userBreathPatterns.userId, user.id));
    if ((n?.n ?? 0) >= 20) throw new AppError('INVALID_STATE', 'At most 20 saved patterns');
    const [row] = await this.db.insert(userBreathPatterns).values({ id: uuidv7(), userId: user.id, ...b }).returning();
    return patternView(row!);
  }

  async deletePattern(user: AppUser, id: string) {
    await this.require('breathwork');
    const gone = await this.db.delete(userBreathPatterns).where(and(eq(userBreathPatterns.id, id), eq(userBreathPatterns.userId, user.id))).returning();
    if (!gone.length) throw new AppError('NOT_FOUND', 'Pattern not found');
  }

  // ───────────── milestones
  async milestones(user: AppUser) {
    await this.require('milestones');
    const [st, days, ded, seen] = await Promise.all([
      this.db.select().from(userStats).where(eq(userStats.userId, user.id)).then((r) => r[0]),
      this.db.select({ n: sql<number>`count(*)::int` }).from(userDailyStats).where(and(eq(userDailyStats.userId, user.id), sql`${userDailyStats.minutes} > 0`)).then((r) => r[0]?.n ?? 0),
      this.db.select({ n: sql<number>`count(*)::int` }).from(dedications).where(eq(dedications.userId, user.id)).then((r) => r[0]?.n ?? 0),
      this.db.select().from(userMilestones).where(eq(userMilestones.userId, user.id)),
    ]);
    const stats: MilestoneStats = { meditations: st?.meditationsTotal ?? 0, minutes: st?.minutesTotal ?? 0, group: st?.groupTotal ?? 0, days, dedications: ded };
    const list = milestones(stats);
    const when = new Map(seen.map((s) => [s.key, s.reachedAt]));
    const fresh = list.filter((m) => m.reached && !when.has(m.key));
    if (fresh.length) {
      const now = new Date();
      await this.db.insert(userMilestones).values(fresh.map((m) => ({ userId: user.id, key: m.key, reachedAt: now }))).onConflictDoNothing();
      for (const m of fresh) when.set(m.key, now);
    }
    return {
      reached: list.filter((m) => m.reached).length, total: MILESTONES.length,
      awards: list.map((m) => ({ ...m, reachedAt: when.get(m.key)?.toISOString() ?? null })),
      world: await this.world(),
    };
  }

  /** "The world so far" (cached 10 minutes). */
  async world() {
    const hit = await this.redis.get('world:sofar').catch(() => null);
    if (hit) return JSON.parse(hit) as { minutes: number; meditations: number; countries: number; dedications: number };
    const [r] = (await this.db.execute<{ minutes: number; meditations: number; countries: number; dedications: number }>(sql`SELECT
        (SELECT coalesce(sum(minutes_total), 0)::bigint FROM user_stats)::float8 AS minutes,
        (SELECT coalesce(sum(meditations_total), 0)::bigint FROM user_stats)::float8 AS meditations,
        (SELECT count(DISTINCT country)::int FROM meditations WHERE counted AND country IS NOT NULL) AS countries,
        (SELECT count(*)::int FROM dedications WHERE status = 'visible') AS dedications`)).rows;
    const out = { minutes: Number(r?.minutes ?? 0), meditations: Number(r?.meditations ?? 0), countries: Number(r?.countries ?? 0), dedications: Number(r?.dedications ?? 0) };
    await this.redis.set('world:sofar', JSON.stringify(out), 'EX', 600).catch(() => null);
    return out;
  }
}
