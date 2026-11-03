import type { betaGrants, entitlements } from '../../db/schema';

type Paid = Pick<typeof entitlements.$inferSelect, 'active' | 'expiresAt'> | null | undefined;
type Grant = Pick<typeof betaGrants.$inferSelect, 'expiresAt' | 'revokedAt'> | null | undefined;

export type AccessSource = 'none' | 'paid' | 'beta' | 'paid+beta';

export interface Access {
  /** The one answer every premium check uses: account usable AND (live paid OR live beta grant). */
  active: boolean;
  source: AccessSource;
  paidActive: boolean;
  betaActive: boolean;
  betaExpiresAt: Date | null;
  /** Suspended or deleting: overrides any entitlement. */
  blocked: boolean;
  /** The soonest moment this answer can change by itself (an expiry), so caches never outlive it. */
  validUntil: Date | null;
}

/**
 * Pure rule (beta spec §7): suspension/deleting beat everything; paid and beta are tracked apart so removing a beta
 * grant can never touch a genuine subscription.
 */
export function resolveAccess(paid: Paid, grant: Grant, state: { suspended: boolean; deleting: boolean }, now = new Date()): Access {
  const blocked = state.suspended || state.deleting;
  const paidActive = !!paid?.active && (!paid.expiresAt || paid.expiresAt > now);
  const betaActive = !!grant && !grant.revokedAt && grant.expiresAt > now;
  const source: AccessSource = blocked ? 'none' : paidActive && betaActive ? 'paid+beta' : paidActive ? 'paid' : betaActive ? 'beta' : 'none';
  const edges = [paidActive ? paid!.expiresAt : null, betaActive ? grant!.expiresAt : null].filter((d): d is Date => !!d);
  // with both live, access lasts until the later expiry; a paid entitlement without an expiry never lapses on its own
  const unbounded = paidActive && !paid!.expiresAt;
  const validUntil = unbounded || !edges.length ? null : new Date(Math.max(...edges.map((d) => d.getTime())));
  return { active: !blocked && (paidActive || betaActive), source, paidActive, betaActive, betaExpiresAt: grant && !grant.revokedAt ? grant.expiresAt : null, blocked, validUntil };
}
