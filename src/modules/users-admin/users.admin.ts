import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import { z } from 'zod';
import { AdminRoles } from '../../common/auth';
import { AppError } from '../../common/errors';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import { Zod } from '../../common/zod';
import { users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { REDIS } from '../../infra/redis';
import { QUEUES, QueueService } from '../../jobs/queues';
import { CONTENT_ROLES, MANAGER_ROLES } from '../admin-auth/rbac';
import { AdminWriter, CurrentActor, type Actor } from '../admin/admin-writer';
import { cursorQuery, IdParam } from '../admin/dto';
import { toCsv, UserDataService } from './user-data.service';

const TABS = ['all', 'guests', 'free', 'trial', 'annual', 'monthly', 'cancelled'] as const;
const ListQuery = z.object({ tab: z.enum(TABS).default('all'), q: z.string().trim().max(80).optional(), ...cursorQuery });
const DeleteDto = z.object({ confirm: z.string().min(1).max(254) }).strict();
const Id = new Zod(IdParam);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const member = sql`(e.active and (e.expires_at is null or e.expires_at > now()))`;
const monthly = sql`e.product_id ilike '%monthly%'`;
const TAB_SQL: Record<(typeof TABS)[number], SQL> = {
  all: sql`true`, guests: sql`u.is_guest`, free: sql`(not u.is_guest and not coalesce(${member}, false) and e.product_id is null)`, trial: sql`(${member} and e.period_type = 'trial')`,
  annual: sql`(${member} and e.period_type <> 'trial' and not ${monthly})`, monthly: sql`(${member} and e.period_type <> 'trial' and ${monthly})`,
  cancelled: sql`(e.product_id is not null and not e.will_renew and e.store <> 'promotional')`,
};

/** "Annual · Founding", "Trial · day 4 of 7", "Free · guest" (the screen's membership column, decided here so every client says the same). */
type Ent = { active: boolean; productId: string | null; periodType: string | null; startedAt: Date | string | null; expiresAt: Date | string | null; willRenew: boolean; isFounding: boolean; store: string | null };
export function membershipOf(u: { isGuest: boolean }, raw: Ent | null) {
  // raw SQL rows give timestamps as text
  const e = raw && { ...raw, startedAt: raw.startedAt ? new Date(raw.startedAt) : null, expiresAt: raw.expiresAt ? new Date(raw.expiresAt) : null };
  const live = !!e?.active && (!e.expiresAt || e.expiresAt > new Date());
  if (live && e!.periodType === 'trial') {
    const day = e!.startedAt ? Math.min(7, Math.floor((Date.now() - e!.startedAt.getTime()) / 86_400_000) + 1) : null;
    return { plan: 'trial', label: day ? `Trial · day ${day} of 7` : 'Trial', status: 'trial' };
  }
  if (live) { const monthlyPlan = /monthly/i.test(e!.productId ?? ''); return { plan: monthlyPlan ? 'monthly' : e!.isFounding ? 'founding' : 'annual', label: monthlyPlan ? 'Monthly' : e!.isFounding ? 'Annual · Founding' : 'Annual', status: e!.willRenew ? 'active' : 'cancelling' }; }
  if (e?.productId && e.store !== 'promotional') return { plan: 'cancelled', label: 'Cancelled', status: 'cancelled' };
  return { plan: 'free', label: u.isGuest ? 'Free · guest' : 'Free · account', status: 'free' };
}

@Injectable()
export class UsersAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly data: UserDataService, private readonly queues: QueueService, private readonly writer: AdminWriter) {}

  private searchSql(q?: string): SQL {
    if (!q) return sql`true`;
    if (UUID.test(q)) return sql`u.id = ${q}::uuid`;
    const like = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    if (q.includes('@')) return sql`u.email ilike ${like + '%'}`; // email prefix
    return sql`(u.first_name ilike ${'%' + like + '%'} or u.email ilike ${like + '%'})`; // name (trigram index) or email prefix
  }

  async counts() {
    const hit = await this.redis.get('users:counts').catch(() => null);
    if (hit) return JSON.parse(hit) as Record<string, number>;
    const [r] = (await this.db.execute<Record<string, number>>(sql`SELECT count(*)::int AS "all", count(*) FILTER (WHERE u.is_guest)::int AS guests, count(*) FILTER (WHERE NOT u.is_guest)::int AS accounts,
        count(*) FILTER (WHERE ${member} AND e.period_type <> 'trial')::int AS paying, count(*) FILTER (WHERE ${member} AND e.period_type = 'trial')::int AS trial
      FROM users u LEFT JOIN entitlements e ON e.user_id = u.id WHERE u.deleted_at IS NULL`)).rows;
    await this.redis.set('users:counts', JSON.stringify(r), 'EX', 30).catch(() => null);
    return r!;
  }

  async list(q: z.infer<typeof ListQuery>) {
    const limit = clampLimit(q.limit, 30);
    const conds: SQL[] = [sql`u.deleted_at is null`, TAB_SQL[q.tab], this.searchSql(q.q)];
    const c = decodeCursor(q.cursor);
    if (c) conds.push(sql`(u.last_active_at, u.id) < (${new Date(String(c.k))}, ${c.id}::uuid)`);
    const rows = (await this.db.execute<Record<string, any>>(sql`SELECT u.id, u.first_name, u.email, u.is_guest, u.country, u.created_at, u.last_active_at, u.muted_at,
        e.active, e.product_id, e.period_type::text AS period_type, e.started_at, e.expires_at, e.will_renew, e.is_founding, e.store::text AS store,
        coalesce(s.meditations_total, 0) AS meditations, coalesce((SELECT sum(minutes) FROM user_daily_stats d WHERE d.user_id = u.id AND d.local_date >= date_trunc('week', now())::date), 0)::int AS week_minutes,
        coalesce((SELECT array_agg(DISTINCT i.provider::text) FROM auth_identities i WHERE i.user_id = u.id AND i.provider <> 'device'), '{}') AS providers
      FROM users u LEFT JOIN entitlements e ON e.user_id = u.id LEFT JOIN user_stats s ON s.user_id = u.id
      WHERE ${sql.join(conds, sql` AND `)} ORDER BY u.last_active_at DESC, u.id DESC LIMIT ${limit + 1}`)).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    const page = rows.slice(0, limit);
    const out = page.map((r) => ({
      id: r.id, name: r.first_name, email: r.email, isGuest: r.is_guest, providers: r.providers, country: r.country, joinedAt: r.created_at, lastActiveAt: r.last_active_at, muted: !!r.muted_at,
      membership: membershipOf({ isGuest: r.is_guest }, r.product_id || r.active ? { active: r.active, productId: r.product_id, periodType: r.period_type, startedAt: r.started_at, expiresAt: r.expires_at, willRenew: r.will_renew, isFounding: r.is_founding, store: r.store } : null),
      weekMinutes: Number(r.week_minutes), meditations: Number(r.meditations),
    }));
    return { data: out, meta: { nextCursor: rows.length > limit ? encodeCursor(new Date(page.at(-1)!.last_active_at).toISOString(), page.at(-1)!.id) : null, counts: await this.counts() } };
  }

  async detail(id: string) {
    const [u] = (await this.db.execute<Record<string, any>>(sql`SELECT * FROM users WHERE id = ${id} AND deleted_at IS NULL`)).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!u) throw new AppError('NOT_FOUND', 'User not found');
    const q = async (s: ReturnType<typeof sql>) => (await this.db.execute<Record<string, any>>(s)).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    const [ids, devs, stats, week, recent, dedications, ent, firstIdentity] = await Promise.all([
      q(sql`SELECT provider::text, created_at FROM auth_identities WHERE user_id = ${id} ORDER BY created_at`),
      q(sql`SELECT platform::text, model, app_version, last_seen_at FROM devices WHERE user_id = ${id} ORDER BY last_seen_at DESC LIMIT 3`),
      q(sql`SELECT minutes_total, meditations_total, group_total, dedications_total, first_meditation_at, last_meditation_at FROM user_stats WHERE user_id = ${id}`),
      q(sql`SELECT count(*) FILTER (WHERE minutes > 0)::int AS days, coalesce(sum(minutes), 0)::int AS minutes FROM user_daily_stats WHERE user_id = ${id} AND local_date >= date_trunc('week', now())::date`),
      q(sql`SELECT m.id, s.title AS session, m.kind::text, m.started_at, m.duration_sec FROM meditations m LEFT JOIN sessions s ON s.id = m.session_id WHERE m.user_id = ${id} ORDER BY m.started_at DESC LIMIT 10`),
      q(sql`SELECT d.id, d.text, d.status::text, d.holding_count, d.created_at, s.title AS session FROM dedications d JOIN sessions s ON s.id = d.session_id WHERE d.user_id = ${id} ORDER BY d.created_at DESC LIMIT 10`),
      q(sql`SELECT active, product_id, period_type::text AS period_type, store::text AS store, started_at, expires_at, will_renew, billing_issue, is_founding FROM entitlements WHERE user_id = ${id}`),
      q(sql`SELECT created_at FROM auth_identities WHERE user_id = ${id} AND provider <> 'device' ORDER BY created_at LIMIT 1`),
    ]);
    const e = ent[0] ?? null;
    const st = stats[0] ?? { minutes_total: 0, meditations_total: 0, group_total: 0 };
    const saved = firstIdentity[0]?.created_at ? new Date(firstIdentity[0].created_at) : null;
    return {
      id: u.id, name: u.first_name, email: u.email, isGuest: u.is_guest, country: u.country, timezone: u.timezone, joinedAt: u.created_at, lastActiveAt: u.last_active_at, muted: !!u.muted_at,
      providers: [...new Set(ids.filter((i) => i.provider !== 'device').map((i) => i.provider))],
      accountSavedAt: saved, wasGuestDays: saved ? Math.max(0, Math.round((saved.getTime() - new Date(u.created_at).getTime()) / 86_400_000)) : null,
      devices: devs.map((d) => ({ platform: d.platform, model: d.model, appVersion: d.app_version, lastSeenAt: d.last_seen_at })),
      reminder: { enabled: u.reminder_enabled, time: u.reminder_time, timezone: u.timezone, groupWarning: u.group_warning, dailyMessagePush: u.daily_message_push },
      stats: { weekDays: week[0]?.days ?? 0, weekMinutes: week[0]?.minutes ?? 0, meditations: st.meditations_total, minutes: st.minutes_total, groupMeditations: st.group_total, avgMinutes: st.meditations_total ? Math.round((st.minutes_total / st.meditations_total) * 10) / 10 : null },
      recentMeditations: recent.map((m) => ({ id: m.id, session: m.session, kind: m.kind, startedAt: m.started_at, durationSec: m.duration_sec })),
      dedications: dedications.map((d) => ({ id: d.id, text: d.text, status: d.status, holdingCount: d.holding_count, createdAt: d.created_at, session: d.session })),
      membership: { ...membershipOf({ isGuest: u.is_guest }, e ? { active: e.active, productId: e.product_id, periodType: e.period_type, startedAt: e.started_at, expiresAt: e.expires_at, willRenew: e.will_renew, isFounding: e.is_founding, store: e.store } : null), productId: e?.product_id ?? null, store: e?.store ?? null, startedAt: e?.started_at ?? null, expiresAt: e?.expires_at ?? null, willRenew: e?.will_renew ?? false, billingIssue: e?.billing_issue ?? false, revenueCatId: u.id },
    };
  }

  /** CSV of everyone matching the filters (max 100,000 rows), for the Users screen's export. */
  async csv(q: { tab: (typeof TABS)[number]; q?: string }) {
    const rows = (await this.db.execute<Record<string, any>>(sql`SELECT u.id, u.first_name AS name, u.email, u.is_guest, u.country, u.created_at AS joined, u.last_active_at AS last_active, e.product_id AS plan, e.period_type::text AS period, e.will_renew
      FROM users u LEFT JOIN entitlements e ON e.user_id = u.id WHERE u.deleted_at IS NULL AND ${TAB_SQL[q.tab]} AND ${this.searchSql(q.q)} ORDER BY u.created_at LIMIT 100000`)).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    return toCsv(rows);
  }

  async startExport(actor: Actor, id: string) {
    await this.exists(id);
    const jobId = await this.data.createJob('user_export', id, actor.id);
    await this.writer.run(actor, { action: 'user.export', type: 'user', id }, async () => ({ result: null, after: { jobId } }));
    await this.queues.add(QUEUES.cron, 'user.export', { jobId, userId: id }, { jobId: `export-${jobId}`, attempts: 2 });
    return { jobId };
  }

  /** Needs the person's email (or the first 8 characters of the id for guests) typed in: nobody deletes the wrong account by accident. */
  async startDelete(actor: Actor, id: string, confirm: string) {
    const [u] = await this.db.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.id, id), sql`${users.deletedAt} is null`));
    if (!u) throw new AppError('NOT_FOUND', 'User not found');
    const expected = (u.email ?? u.id.slice(0, 8)).toLowerCase();
    if (confirm.trim().toLowerCase() !== expected) throw new AppError('VALIDATION_FAILED', 'The confirmation does not match', { fields: [{ path: 'confirm', message: `Type ${u.email ? 'the email address' : 'the first 8 characters of the user id'} to confirm` }], expected: u.email ? 'email' : 'id8' });
    const jobId = await this.data.createJob('user_delete', id, actor.id);
    await this.queues.add(QUEUES.cron, 'user.delete', { jobId, userId: id, adminId: actor.id }, { jobId: `delete-${jobId}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    return { jobId };
  }

  private async exists(id: string) {
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (!u) throw new AppError('NOT_FOUND', 'User not found');
  }
}

@ApiTags('Admin Users')
@ApiBearerAuth()
@Controller('v1/admin/users')
export class UsersAdminController {
  constructor(private readonly svc: UsersAdminService) {}

  @AdminRoles(...CONTENT_ROLES) @Get() list(@Query(new Zod(ListQuery)) q: z.infer<typeof ListQuery>) { return this.svc.list(q); }

  @AdminRoles(...MANAGER_ROLES) @Get('export')
  async export(@Query(new Zod(ListQuery.pick({ tab: true, q: true }))) q: { tab: (typeof TABS)[number]; q?: string }, @Res() res: FastifyReply) {
    const csv = await this.svc.csv(q);
    void res.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="wehum-users.csv"').send(csv);
  }

  @AdminRoles(...CONTENT_ROLES) @Get(':id') detail(@Param('id', Id) id: string) { return this.svc.detail(id); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(202) @Post(':id/export') export1(@CurrentActor() a: Actor, @Param('id', Id) id: string) { return this.svc.startExport(a, id); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(202) @Delete(':id') remove(@CurrentActor() a: Actor, @Param('id', Id) id: string, @Body(new Zod(DeleteDto)) b: z.infer<typeof DeleteDto>) { return this.svc.startDelete(a, id, b.confirm); }
}
