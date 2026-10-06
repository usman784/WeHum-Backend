import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { z } from 'zod';
import { env } from '../../config/env';
import { entitlements, offers, subscriptionEvents, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { RealtimeBus } from '../../infra/realtime-bus';
import { REDIS } from '../../infra/redis';
import { EntitlementService } from '../entitlements/entitlement.service';
import { toEntitlement } from '../me/me.mapper';
import { RevenueCatClient } from './revenuecat.client';

export const FOUNDING_PRODUCT = 'wehum_annual_founding';
const uuid = z.string().uuid();

const STORE = { APP_STORE: 'app_store', MAC_APP_STORE: 'app_store', PLAY_STORE: 'play_store', PROMOTIONAL: 'promotional', STRIPE: 'stripe' } as const;
const PERIOD = { TRIAL: 'trial', NORMAL: 'normal', INTRO: 'intro', PROMOTIONAL: 'promotional' } as const;
/** Events that leave the member with access (until `expiration_at_ms`). */
const GRANTING = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT']);

export interface RcEvent {
  id: string; type: string; app_user_id?: string; original_app_user_id?: string; aliases?: string[];
  transferred_from?: string[]; transferred_to?: string[]; product_id?: string; period_type?: string; store?: string;
  event_timestamp_ms: number; expiration_at_ms?: number | null; purchased_at_ms?: number | null;
  price?: number | null; price_in_purchased_currency?: number | null; currency?: string | null;
}

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * RevenueCat → `entitlements` (spec §8.4). `process` is safe to call twice for the same event (claimed by `processed_at`)
 * and ignores events older than what the entitlement already knows. Money comes from the event, never from us.
 */
@Injectable()
export class RcProcessor {
  private readonly log = new Logger('RcProcessor');
  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly bus: RealtimeBus,
    private readonly ent: EntitlementService, private readonly rc: RevenueCatClient,
  ) {}

  /** Candidate ids for the user of an event: the app user id first, then aliases. Only uuids are ours (RevenueCat anonymous ids are not). */
  private ids(e: RcEvent, extra: string[] = []) {
    return [...new Set([e.app_user_id, ...(e.aliases ?? []), e.original_app_user_id, ...extra].filter((x): x is string => !!x && uuid.safeParse(x).success))];
  }

  /** The user a purchase belongs to. The webhook can arrive before the app created the guest: then a stub user is made (spec §16 edge case). */
  private async resolveUser(tx: Tx, e: RcEvent): Promise<string | null> {
    const ids = this.ids(e);
    if (!ids.length) return null;
    const found = await tx.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    const first = ids.find((i) => found.some((f) => f.id === i)) ?? ids[0]!;
    if (!found.some((f) => f.id === first)) await tx.insert(users).values({ id: first, isGuest: true }).onConflictDoNothing();
    return first;
  }

  async process(eventId: string): Promise<'applied' | 'skipped' | 'duplicate'> {
    let notify: { userId: string; ent: ReturnType<typeof toEntitlement> }[] = [];
    let summary: Record<string, unknown> | null = null;
    let closeFounding = false;

    const outcome = await this.db.transaction(async (tx) => {
      const [claimed] = await tx.update(subscriptionEvents).set({ processedAt: new Date() })
        .where(sql`${subscriptionEvents.id} = ${eventId} and ${subscriptionEvents.processedAt} is null`).returning({ raw: subscriptionEvents.raw });
      if (!claimed) return 'duplicate' as const;
      const e = (claimed.raw as { event: RcEvent }).event;
      if (e.type === 'TEST') return 'skipped' as const;

      if (e.type === 'TRANSFER') {
        for (const from of (e.transferred_from ?? []).filter((x) => uuid.safeParse(x).success)) {
          const [row] = await tx.update(entitlements).set({ active: false, willRenew: false, lastEventAt: new Date(e.event_timestamp_ms), updatedAt: new Date() }).where(eq(entitlements.userId, from)).returning();
          if (row) notify.push({ userId: from, ent: toEntitlement(row) });
        }
        // the receiving account gets its state from RevenueCat (the event carries no expiry): see `syncUser` below
        summary = { id: e.id, type: e.type, userId: null, at: new Date(e.event_timestamp_ms).toISOString() };
        await tx.update(subscriptionEvents).set({ userId: (e.transferred_to ?? []).find((x) => uuid.safeParse(x).success) ?? null }).where(eq(subscriptionEvents.id, e.id));
        return 'applied' as const;
      }

      const userId = await this.resolveUser(tx, e);
      await tx.update(subscriptionEvents).set({ userId }).where(eq(subscriptionEvents.id, e.id));
      summary = { id: e.id, type: e.type, userId, productId: e.product_id ?? null, periodType: e.period_type?.toLowerCase() ?? null, priceUsd: e.price ?? null, at: new Date(e.event_timestamp_ms).toISOString() };
      if (!userId) return 'skipped' as const;

      const [cur] = await tx.select().from(entitlements).where(eq(entitlements.userId, userId)).for('update');
      const eventAt = new Date(e.event_timestamp_ms);
      if (cur?.lastEventAt && eventAt < cur.lastEventAt) return 'skipped' as const; // out of order: a newer event was applied already

      const expiresAt = e.expiration_at_ms ? new Date(e.expiration_at_ms) : null;
      const patch: Partial<typeof entitlements.$inferInsert> = { lastEventAt: eventAt, updatedAt: new Date() };
      const product = e.product_id ?? cur?.productId ?? null;
      if (GRANTING.has(e.type)) {
        Object.assign(patch, {
          active: !expiresAt || expiresAt > new Date(), productId: product, store: (e.store && STORE[e.store as keyof typeof STORE]) || cur?.store || null,
          periodType: (e.period_type && PERIOD[e.period_type as keyof typeof PERIOD]) || cur?.periodType || null,
          startedAt: cur?.startedAt ?? (e.purchased_at_ms ? new Date(e.purchased_at_ms) : eventAt), expiresAt,
          willRenew: e.type !== 'NON_RENEWING_PURCHASE', billingIssue: false, isFounding: product === FOUNDING_PRODUCT,
        });
      } else if (e.type === 'CANCELLATION' || e.type === 'SUBSCRIPTION_PAUSED') {
        Object.assign(patch, { willRenew: false, ...(expiresAt && { expiresAt }) });
      } else if (e.type === 'BILLING_ISSUE') {
        Object.assign(patch, { billingIssue: true });
      } else if (e.type === 'EXPIRATION') {
        Object.assign(patch, { active: false, willRenew: false, ...(expiresAt && { expiresAt }) });
      } else {
        return 'skipped' as const; // unknown types are kept in the event log only
      }
      const [row] = cur
        ? await tx.update(entitlements).set(patch).where(eq(entitlements.userId, userId)).returning()
        : await tx.insert(entitlements).values({ userId, active: false, ...patch }).returning();
      notify.push({ userId, ent: toEntitlement(row) });

      // Founding counter: one slot per new Founding purchase (a trial that converts later is the same slot).
      if (e.type === 'INITIAL_PURCHASE' && e.product_id === FOUNDING_PRODUCT) {
        const [o] = await tx.update(offers).set({ taken: sql`${offers.taken} + 1` }).where(eq(offers.id, 'founding')).returning();
        if (o && o.open && o.taken >= o.cap) {
          await tx.update(offers).set({ open: false, closedAt: new Date() }).where(eq(offers.id, 'founding'));
          closeFounding = true;
        }
      }
      return 'applied' as const;
    });

    await this.after(outcome, notify, summary, closeFounding);
    if (outcome === 'applied') {
      const ev = await this.db.select({ raw: subscriptionEvents.raw }).from(subscriptionEvents).where(eq(subscriptionEvents.id, eventId));
      const e = (ev[0]?.raw as { event?: RcEvent } | undefined)?.event;
      if (e?.type === 'TRANSFER') for (const to of (e.transferred_to ?? []).filter((x) => uuid.safeParse(x).success)) await this.syncUser(to).catch((err) => this.log.warn(`transfer sync failed: ${(err as Error).message}`));
    }
    return outcome;
  }

  private async after(outcome: string, notify: { userId: string; ent: ReturnType<typeof toEntitlement> }[], summary: Record<string, unknown> | null, closeFounding: boolean) {
    if (outcome === 'duplicate') return;
    await this.redis.del('dash:subs', 'offer:founding').catch(() => 0);
    for (const n of notify) {
      await this.ent.invalidate(n.userId);
      await this.bus.publish('entitlement:changed', { userId: n.userId, entitlement: { active: n.ent.active, productId: n.ent.productId, periodType: n.ent.periodType, expiresAt: n.ent.expiresAt, billingIssue: n.ent.billingIssue } });
    }
    if (summary) await this.bus.publish('subs:event', { event: summary });
    if (closeFounding) await this.rc.switchOffering(env.REVENUECAT_REGULAR_OFFERING).catch((e) => this.log.error(`could not switch the offering: ${(e as Error).message}`));
  }

  /** Re-read one user from RevenueCat (sync button, reconcile job, transfers). Returns the stored entitlement. */
  async syncUser(userId: string) {
    const sub = await this.rc.getSubscriber(userId);
    const now = new Date();
    const e = sub?.entitlement;
    const active = !!e && (!e.expiresAt || e.expiresAt > now);
    const values = {
      active, productId: e?.productId ?? null, periodType: ((sub?.subscription?.periodType ?? '').toLowerCase() as 'trial' | 'normal' | 'intro' | 'promotional') || null,
      store: (sub?.subscription?.store ? STORE[sub.subscription.store.toUpperCase() as keyof typeof STORE] : undefined) ?? null,
      startedAt: e?.purchasedAt ?? null, expiresAt: e?.expiresAt ?? null, willRenew: sub?.subscription?.willRenew ?? false,
      billingIssue: sub?.subscription?.billingIssue ?? false, isFounding: e?.productId === FOUNDING_PRODUCT, updatedAt: now,
    };
    await this.db.insert(users).values({ id: userId, isGuest: true }).onConflictDoNothing();
    const [row] = await this.db.insert(entitlements).values({ userId, ...values }).onConflictDoUpdate({ target: entitlements.userId, set: values }).returning();
    await this.ent.invalidate(userId);
    await this.redis.del('dash:subs').catch(() => 0);
    await this.bus.publish('entitlement:changed', { userId, entitlement: { active: toEntitlement(row).active, productId: row!.productId, periodType: row!.periodType, expiresAt: row!.expiresAt?.toISOString() ?? null, billingIssue: row!.billingIssue } });
    return row!;
  }

  /** Daily: members whose entitlement was not touched for 24 h and who are active or about to expire are re-read. */
  async reconcile(limit = 200): Promise<number> {
    const rows = await this.db.select({ id: entitlements.userId }).from(entitlements)
      .where(sql`${entitlements.updatedAt} < now() - interval '24 hours' and (${entitlements.active} or ${entitlements.expiresAt} > now() - interval '2 days')`)
      .orderBy(entitlements.updatedAt).limit(limit);
    let n = 0;
    for (const r of rows) { try { await this.syncUser(r.id); n++; } catch (e) { this.log.warn(`reconcile ${r.id}: ${(e as Error).message}`); } }
    return n;
  }
}
