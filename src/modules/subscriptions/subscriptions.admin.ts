import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import { z } from 'zod';
import { AdminRoles } from '../../common/auth';
import { AppError } from '../../common/errors';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import { Zod } from '../../common/zod';
import { entitlements, offers, subscriptionEvents, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { REDIS } from '../../infra/redis';
import { CONTENT_ROLES, MANAGER_ROLES } from '../admin-auth/rbac';
import { AdminWriter, CurrentActor, type Actor } from '../admin/admin-writer';
import { cursorQuery, IdParam } from '../admin/dto';
import { FOUNDING_PRODUCT, RcProcessor } from './rc.processor';
import { RevenueCatClient } from './revenuecat.client';
import { env } from '../../config/env';
import { toCsv } from '../users-admin/user-data.service';

const Tabs = ['all', 'trial', 'annual', 'monthly', 'problem', 'cancelled'] as const;
const MembersQuery = z.object({ tab: z.enum(Tabs).default('all'), ...cursorQuery });
const EventsQuery = z.object(cursorQuery);
const GiftDto = z.object({ days: z.number().int().min(1).max(365) }).strict();
const IdP = new Zod(IdParam);

const isMonthly = sql`${entitlements.productId} ilike '%monthly%'`;
const live = sql`${entitlements.active} and (${entitlements.expiresAt} is null or ${entitlements.expiresAt} > now())`;

@Injectable()
export class SubscriptionsAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly writer: AdminWriter, private readonly rc: RevenueCatClient, private readonly proc: RcProcessor) {}

  /** KPIs of the Subscriptions screen. Money is from the events' own USD price (spec §8.4), never invented. */
  async summary() {
    const [counts, founding, prices, trials, plans] = await Promise.all([
      this.db.select({
        trial: sql<number>`count(*) filter (where ${live} and ${entitlements.periodType} = 'trial')::int`,
        foundingPaying: sql<number>`count(*) filter (where ${live} and ${entitlements.periodType} <> 'trial' and ${entitlements.isFounding})::int`,
        monthlyPaying: sql<number>`count(*) filter (where ${live} and ${entitlements.periodType} <> 'trial' and ${isMonthly})::int`,
        annualPaying: sql<number>`count(*) filter (where ${live} and ${entitlements.periodType} <> 'trial' and not ${entitlements.isFounding} and not ${isMonthly})::int`,
        cancelled: sql<number>`count(*) filter (where not ${entitlements.willRenew} and ${entitlements.productId} is not null and ${entitlements.store} <> 'promotional')::int`,
        problems: sql<number>`count(*) filter (where ${entitlements.billingIssue})::int`,
      }).from(entitlements).then((r) => r[0]!),
      this.db.select().from(offers).where(eq(offers.id, 'founding')).then((r) => r[0]),
      this.db.execute<{ product: string; price: string }>(sql`SELECT DISTINCT ON (product_id) product_id AS product, price_usd::text AS price FROM subscription_events WHERE price_usd > 0 AND product_id IS NOT NULL ORDER BY product_id, event_at DESC`),
      this.db.execute<{ started: number; converted: number }>(sql`
        SELECT count(DISTINCT t.user_id)::int AS started,
               count(DISTINCT t.user_id) FILTER (WHERE EXISTS (SELECT 1 FROM subscription_events c WHERE c.user_id = t.user_id AND c.type = 'RENEWAL' AND c.period_type = 'normal' AND c.event_at > t.event_at))::int AS converted
        FROM subscription_events t WHERE t.type = 'INITIAL_PURCHASE' AND t.period_type = 'trial' AND t.event_at > now() - interval '30 days'`),
      this.db.select({ product: entitlements.productId, n: sql<number>`count(*) filter (where ${live})::int` }).from(entitlements).where(sql`${entitlements.productId} is not null`).groupBy(entitlements.productId),
    ]);
    const price = new Map(prices.rows.map((p) => [p.product, Number(p.price)]));
    // MRR = active monthly + annual ÷ 12, with the latest USD price RevenueCat reported for each product (trials are not revenue yet)
    const paying = plans.length ? await this.db.select({ product: entitlements.productId, n: sql<number>`count(*) filter (where ${live} and ${entitlements.periodType} <> 'trial')::int` }).from(entitlements).where(sql`${entitlements.productId} is not null`).groupBy(entitlements.productId) : [];
    let mrr = 0;
    for (const p of paying) mrr += p.n * ((price.get(p.product ?? '') ?? 0) / (/monthly/i.test(p.product ?? '') ? 1 : 12));
    const t = trials.rows[0] ?? { started: 0, converted: 0 };
    return {
      payingMembers: { total: counts.foundingPaying + counts.monthlyPaying + counts.annualPaying, founding: counts.foundingPaying, annual: counts.annualPaying, monthly: counts.monthlyPaying },
      inTrial: counts.trial, mrrUsd: Math.round(mrr * 100) / 100,
      trialToPaid: t.started ? t.converted / t.started : null, trialsStarted30d: t.started,
      cancelled: counts.cancelled, paymentProblems: counts.problems,
      founding: { taken: founding?.taken ?? 0, cap: founding?.cap ?? 0, left: Math.max(0, (founding?.cap ?? 0) - (founding?.taken ?? 0)), open: !!founding?.open && (founding.taken < founding.cap), closedAt: founding?.closedAt?.toISOString() ?? null, productId: founding?.productId ?? FOUNDING_PRODUCT },
      plans: plans.map((p) => ({ productId: p.product, priceUsd: price.get(p.product ?? '') ?? null, trialDays: 7, active: p.n })),
    };
  }

  private tabConds(tab: (typeof Tabs)[number]): SQL[] {
    const conds: SQL[] = [sql`${entitlements.productId} is not null`];
    if (tab === 'trial') conds.push(live, eq(entitlements.periodType, 'trial'));
    if (tab === 'annual') conds.push(live, sql`${entitlements.periodType} <> 'trial'`, sql`not ${isMonthly}`);
    if (tab === 'monthly') conds.push(live, sql`${entitlements.periodType} <> 'trial'`, isMonthly);
    if (tab === 'problem') conds.push(eq(entitlements.billingIssue, true));
    if (tab === 'cancelled') conds.push(eq(entitlements.willRenew, false), sql`${entitlements.store} <> 'promotional'`);
    return conds;
  }

  /** CSV of the members in one tab (max 100,000 rows), for the Subscriptions screen's export. */
  async membersCsv(tab: (typeof Tabs)[number]) {
    const rows = await this.db.select({
      user_id: entitlements.userId, name: users.firstName, email: users.email, country: users.country, product: entitlements.productId, period: entitlements.periodType,
      store: entitlements.store, started: entitlements.startedAt, expires: entitlements.expiresAt, will_renew: entitlements.willRenew, billing_issue: entitlements.billingIssue, founding: entitlements.isFounding,
    }).from(entitlements).innerJoin(users, eq(users.id, entitlements.userId)).where(and(...this.tabConds(tab))).orderBy(desc(entitlements.updatedAt)).limit(100_000);
    return toCsv(rows.map((r) => ({ ...r, started: r.started?.toISOString() ?? '', expires: r.expires?.toISOString() ?? '' })));
  }

  async members(q: z.infer<typeof MembersQuery>) {
    const limit = clampLimit(q.limit, 30);
    const conds = this.tabConds(q.tab);
    const c = decodeCursor(q.cursor);
    if (c) conds.push(or(lt(entitlements.updatedAt, new Date(String(c.k))), and(eq(entitlements.updatedAt, new Date(String(c.k))), lt(entitlements.userId, c.id)))!);
    const rows = await this.db.select({ e: entitlements, name: users.firstName, email: users.email, country: users.country }).from(entitlements)
      .innerJoin(users, eq(users.id, entitlements.userId)).where(and(...conds)).orderBy(desc(entitlements.updatedAt), desc(entitlements.userId)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      data: page.map((r) => ({
        userId: r.e.userId, name: r.name, email: r.email, country: r.country, productId: r.e.productId, periodType: r.e.periodType, store: r.e.store,
        active: r.e.active && (!r.e.expiresAt || r.e.expiresAt > new Date()), startedAt: r.e.startedAt, expiresAt: r.e.expiresAt, willRenew: r.e.willRenew, billingIssue: r.e.billingIssue, isFounding: r.e.isFounding,
      })),
      meta: { nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.e.updatedAt.toISOString(), page.at(-1)!.e.userId) : null },
    };
  }

  async events(q: z.infer<typeof EventsQuery>) {
    const limit = clampLimit(q.limit, 30);
    const c = decodeCursor(q.cursor);
    const cond = c ? or(lt(subscriptionEvents.eventAt, new Date(String(c.k))), and(eq(subscriptionEvents.eventAt, new Date(String(c.k))), lt(subscriptionEvents.id, c.id))) : undefined;
    const rows = await this.db.select({ e: subscriptionEvents, name: users.firstName, email: users.email }).from(subscriptionEvents)
      .leftJoin(users, eq(users.id, subscriptionEvents.userId)).where(cond).orderBy(desc(subscriptionEvents.eventAt), desc(subscriptionEvents.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      data: page.map((r) => ({ id: r.e.id, type: r.e.type, userId: r.e.userId, name: r.name, email: r.email, productId: r.e.productId, periodType: r.e.periodType, priceUsd: r.e.priceUsd === null ? null : Number(r.e.priceUsd), eventAt: r.e.eventAt })),
      meta: { nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.e.eventAt.toISOString(), page.at(-1)!.e.id) : null },
    };
  }

  /** "End offer now": no new Founding slot is sold; RevenueCat's current offering switches to the regular one. */
  async closeFounding(actor: Actor) {
    const [o] = await this.db.select().from(offers).where(eq(offers.id, 'founding'));
    if (!o) throw new AppError('NOT_FOUND', 'No Founding offer');
    if (!o.open) throw new AppError('INVALID_STATE', 'The Founding offer is already closed');
    await this.rc.switchOffering(env.REVENUECAT_REGULAR_OFFERING); // first: if RevenueCat is down nothing changes and the admin can retry
    await this.writer.run(actor, { action: 'offer.close', type: 'config', id: 'founding', invalidate: ['offer:founding'] }, async (tx) => {
      await tx.update(offers).set({ open: false, closedAt: new Date() }).where(eq(offers.id, 'founding'));
      return { result: null, before: { open: true, taken: o.taken }, after: { open: false, taken: o.taken }, events: [{ topic: 'config:changed', payload: { key: 'founding', version: 0 } }] };
    });
    await this.redis.del('dash:subs');
    return this.summary().then((s) => s.founding);
  }

  /** Support gift: free premium for N days through RevenueCat, then the entitlement is re-read. */
  async gift(actor: Actor, userId: string, days: number) {
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!u) throw new AppError('NOT_FOUND', 'User not found');
    const until = new Date(Date.now() + days * 86_400_000);
    await this.rc.grantPromotional(userId, until);
    await this.writer.run(actor, { action: 'user.gift', type: 'user', id: userId }, async () => ({ result: null, after: { days, until: until.toISOString() } }));
    const row = await this.proc.syncUser(userId);
    return { active: row.active, expiresAt: row.expiresAt };
  }
}

@ApiTags('Admin Subscriptions')
@ApiBearerAuth()
@Controller('v1/admin')
export class SubscriptionsAdminController {
  constructor(private readonly subs: SubscriptionsAdminService) {}

  @AdminRoles(...CONTENT_ROLES) @Get('subscriptions/summary') summary() { return this.subs.summary(); }
  @AdminRoles(...MANAGER_ROLES) @Get('subscriptions/members/export')
  async export(@Query(new Zod(MembersQuery.pick({ tab: true }))) q: { tab: (typeof Tabs)[number] }, @Res() res: FastifyReply) {
    const csv = await this.subs.membersCsv(q.tab);
    void res.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="wehum-members-${q.tab}.csv"`).send(csv);
  }
  @AdminRoles(...CONTENT_ROLES) @Get('subscriptions/members') members(@Query(new Zod(MembersQuery)) q: z.infer<typeof MembersQuery>) { return this.subs.members(q); }
  @AdminRoles(...CONTENT_ROLES) @Get('subscriptions/events') events(@Query(new Zod(EventsQuery)) q: z.infer<typeof EventsQuery>) { return this.subs.events(q); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(200) @Post('offers/founding/close') close(@CurrentActor() a: Actor) { return this.subs.closeFounding(a); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(200) @Post('users/:id/gift') gift(@CurrentActor() a: Actor, @Param('id', IdP) id: string, @Body(new Zod(GiftDto)) b: z.infer<typeof GiftDto>) { return this.subs.gift(a, id, b.days); }
}
