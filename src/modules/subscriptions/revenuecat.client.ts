import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';

/** What we read from `GET /v1/subscribers/{id}` (only the fields the entitlement needs). */
export interface RcSubscriber {
  entitlement: { productId: string; expiresAt: Date | null; purchasedAt: Date | null } | null;
  subscription: { periodType: string | null; store: string | null; willRenew: boolean; billingIssue: boolean } | null;
}

/**
 * RevenueCat REST (spec §8.4). Never called from a user request path except the explicit "sync" button; tests replace
 * `fetchImpl`. Prices and trials always come from RevenueCat and the stores, never from here.
 */
@Injectable()
export class RevenueCatClient {
  private readonly log = new Logger('RevenueCat');
  /** Replaced in tests. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  private async call(path: string, init: RequestInit = {}) {
    if (!env.REVENUECAT_API_KEY_V2) throw new AppError('DEPENDENCY_DOWN', 'RevenueCat is not configured');
    const res = await this.fetchImpl(`${env.REVENUECAT_BASE_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.REVENUECAT_API_KEY_V2}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      this.log.warn(`${init.method ?? 'GET'} ${path} → ${res.status}`);
      throw new AppError('DEPENDENCY_DOWN', 'RevenueCat did not answer');
    }
    return (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  async getSubscriber(appUserId: string): Promise<RcSubscriber | null> {
    const body = await this.call(`/v1/subscribers/${encodeURIComponent(appUserId)}`);
    if (!body) return null;
    const sub = body.subscriber ?? {};
    const ent = sub.entitlements?.premium;
    const prod = ent ? sub.subscriptions?.[ent.product_identifier] : undefined;
    return {
      entitlement: ent ? { productId: ent.product_identifier, expiresAt: ent.expires_date ? new Date(ent.expires_date) : null, purchasedAt: ent.purchase_date ? new Date(ent.purchase_date) : null } : null,
      subscription: prod ? { periodType: prod.period_type ?? null, store: prod.store ?? null, willRenew: !prod.unsubscribe_detected_at, billingIssue: !!prod.billing_issues_detected_at } : null,
    };
  }

  /** Free premium until `endsAt` (support gift). */
  async grantPromotional(appUserId: string, endsAt: Date) {
    await this.call(`/v1/subscribers/${encodeURIComponent(appUserId)}/entitlements/premium/promotional`, {
      method: 'POST', body: JSON.stringify({ end_time_ms: endsAt.getTime() }),
    });
  }

  /** Make `regular` the current offering (the Founding offer is over). Idempotent on RevenueCat's side. */
  async switchOffering(lookupKey: string) {
    await this.call(`/v2/projects/${env.REVENUECAT_PROJECT_ID}/offerings/${encodeURIComponent(lookupKey)}`, { method: 'POST', body: JSON.stringify({ is_current: true }) });
  }
}
