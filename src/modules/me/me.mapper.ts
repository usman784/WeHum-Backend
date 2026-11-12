import { authIdentities, entitlements, users } from '../../db/schema';
import type { Access } from '../entitlements/access';

type U = typeof users.$inferSelect;
type I = Pick<typeof authIdentities.$inferSelect, 'provider'>;
type E = typeof entitlements.$inferSelect | undefined | null;

/**
 * The entitlement as the app sees it. Without `access` it is the paid row alone (old behaviour); with it, beta access is
 * folded in (`source`, `betaExpiresAt`) and `rev` lets a client drop an older event that arrives late.
 */
export function toEntitlement(e: E, access?: Access, rev = 0) {
  const paidActive = !!e?.active && (!e.expiresAt || e.expiresAt > new Date());
  const betaOnly = !!access && access.betaActive && !access.paidActive && !access.blocked;
  return {
    active: access ? access.active : paidActive,
    productId: betaOnly ? null : (e?.productId ?? null),
    periodType: betaOnly ? 'promotional' : (e?.periodType ?? null),
    expiresAt: (betaOnly ? access!.betaExpiresAt : e?.expiresAt)?.toISOString() ?? null,
    willRenew: betaOnly ? false : (e?.willRenew ?? false),
    billingIssue: e?.billingIssue ?? false,
    isFounding: e?.isFounding ?? false,
    source: access?.source ?? (paidActive ? 'paid' : 'none'),
    betaExpiresAt: access?.betaExpiresAt?.toISOString() ?? null,
    rev,
  };
}

/** Public shape of the current user (backend spec §5.4 bootstrap.me). */
export function toMe(u: U, ids: I[], e: E, avatarUrl: string | null = null, access?: Access) {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    bio: u.bio,
    username: u.username,
    usernameChangedAt: u.usernameChangedAt?.toISOString() ?? null,
    usernameNextChangeAt: u.usernameChangedAt ? new Date(u.usernameChangedAt.getTime() + 7 * 86_400_000).toISOString() : null,
    avatarUrl,
    email: u.email,
    isGuest: u.isGuest,
    providers: [...new Set(ids.map((i) => i.provider).filter((p) => p !== 'device'))],
    country: u.country,
    city: u.city,
    timezone: u.timezone,
    locale: u.locale,
    theme: u.theme,
    reminder: { enabled: u.reminderEnabled, time: u.reminderTime },
    groupWarning: u.groupWarning,
    dailyMessagePush: u.dailyMessagePush,
    showCountry: u.showCountry,
    weeklyGoal: u.weeklyGoal,
    createdAt: u.createdAt.toISOString(),
    entitlement: toEntitlement(e, access, u.accessRev),
  };
}
export type Me = ReturnType<typeof toMe>;
