import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { CommunityService } from '../community/community.service';
import { GroupService } from '../today/group.service';
import { SubscriptionsAdminService } from '../subscriptions/subscriptions.admin';
import { AnalyticsService, addDay, utcDay } from './analytics.service';

/** The Dashboard (screen 01): numbers that are live, the week's messages, top meditations and what needs attention. */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly analytics: AnalyticsService,
    private readonly subs: SubscriptionsAdminService, private readonly community: CommunityService, private readonly group: GroupService,
  ) {}

  /** Moderators see only the moderation slice. */
  async get(role: string, now = Date.now()) {
    const open = await this.community.openCount();
    const reported = { kind: 'reported_dedications', count: open };
    if (role === 'moderator') return { moderationOpen: open, needsAttention: open ? [reported] : [], at: now };

    const today = utcDay(now);
    const monday = addDay(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
    const week = Array.from({ length: 7 }, (_, i) => addDay(monday, i));
    const [agg, medsToday, medsLastWeek, summary, lib, messages, top, motd, nextGroup] = await Promise.all([
      this.redis.get(K.liveAggLast).then((v) => (v ? (JSON.parse(v) as { total?: number; countries?: number }) : null)),
      this.analytics.medsOn(today), this.analytics.medsOn(addDay(today, -7)), this.subs.summary(),
      this.db.execute<{ sessions: number; programs: number; themes: number }>(sql`SELECT (SELECT count(*) FROM sessions WHERE status='live')::int AS sessions, (SELECT count(*) FROM programs WHERE status='live')::int AS programs, (SELECT count(*) FROM themes WHERE visible)::int AS themes`).then((r) => r.rows[0]!),
      this.db.execute<{ date: string; title: string; type: string; status: string }>(sql`SELECT date::text, title, type::text, status::text FROM daily_messages WHERE date >= ${monday}::date AND date <= ${week[6]}::date ORDER BY date`).then((r) => r.rows),
      this.analytics.topSessions(7, 5),
      this.db.execute<{ date: string; title: string; lengths: number[] }>(sql`SELECT d.date::text, s.title, coalesce((SELECT array_agg(v.length_min ORDER BY v.length_min) FROM motd_variants v JOIN media_assets a ON a.id = v.media_id AND a.status = 'ready' WHERE v.date = d.date), '{}') AS lengths FROM motd_days d JOIN sessions s ON s.id = d.session_id WHERE d.date >= ${today}::date AND d.date <= ${addDay(today, 7)}::date ORDER BY d.date`).then((r) => r.rows),
      this.group.next(now),
    ]);
    const byDate = new Map(messages.map((m) => [m.date, m]));
    const attention: Record<string, unknown>[] = [];
    if (open) attention.push(reported);
    for (let i = 0; i < 7; i++) { const d = addDay(today, i); const m = byDate.get(d); if (!m || (m.status !== 'live' && m.status !== 'scheduled')) { attention.push({ kind: 'missing_daily_message', date: d }); break; } }
    for (const m of motd) { const missing = [10, 30, 45].filter((l) => !m.lengths.includes(l)); if (missing.length) { attention.push({ kind: 'motd_missing_variant', date: m.date, title: m.title, lengths: missing }); break; } }
    const nextMotdMissing = !motd.some((m) => m.date === addDay(today, 1));
    if (nextMotdMissing) attention.push({ kind: 'motd_missing', date: addDay(today, 1) });
    if (summary.founding.open) attention.push({ kind: 'founding', taken: summary.founding.taken, cap: summary.founding.cap });
    return {
      at: now,
      kpis: {
        liveNow: agg?.total ?? 0, liveCountries: agg?.countries ?? 0, meditationsToday: medsToday, meditationsLastWeekSameDay: medsLastWeek,
        meditationsDeltaPct: medsLastWeek ? Math.round(((medsToday - medsLastWeek) / medsLastWeek) * 1000) / 10 : null,
        payingMembers: summary.payingMembers.total, inTrial: summary.inTrial, mrrUsd: summary.mrrUsd, library: lib,
      },
      moderationOpen: open,
      dailyMessages: week.map((d) => ({ date: d, title: byDate.get(d)?.title ?? null, type: byDate.get(d)?.type ?? null, status: byDate.get(d)?.status ?? 'missing' })),
      topSessions: top.map((t) => ({ id: t.id, title: t.title, theme: t.theme, plays: t.plays, completion: t.completion })),
      needsAttention: attention,
      nextGroup: { startsAt: nextGroup.startsAt, title: nextGroup.title, lengthMin: nextGroup.lengthMin, state: nextGroup.state, waiting: nextGroup.waiting },
      founding: summary.founding,
    };
  }
}
