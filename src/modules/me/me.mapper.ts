import { authIdentities, entitlements, users } from '../../db/schema';

type U = typeof users.$inferSelect;
type I = Pick<typeof authIdentities.$inferSelect, 'provider'>;
type E = typeof entitlements.$inferSelect | undefined | null;

export function toEntitlement(e: E) {
  const active = !!e?.active && (!e.expiresAt || e.expiresAt > new Date());
  return {
    active,
    productId: e?.productId ?? null,
    periodType: e?.periodType ?? null,
    expiresAt: e?.expiresAt?.toISOString() ?? null,
    willRenew: e?.willRenew ?? false,
    billingIssue: e?.billingIssue ?? false,
    isFounding: e?.isFounding ?? false,
  };
}

/** Public shape of the current user (backend spec §5.4 bootstrap.me). */
export function toMe(u: U, ids: I[], e: E, avatarUrl: string | null = null) {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    username: u.username,
    usernameChangedAt: u.usernameChangedAt?.toISOString() ?? null,
    usernameNextChangeAt: u.usernameChangedAt ? new Date(u.usernameChangedAt.getTime() + 7 * 86_400_000).toISOString() : null,
    avatarUrl,
    email: u.email,
    isGuest: u.isGuest,
    providers: [...new Set(ids.map((i) => i.provider).filter((p) => p !== 'device'))],
    country: u.country,
    timezone: u.timezone,
    locale: u.locale,
    theme: u.theme,
    reminder: { enabled: u.reminderEnabled, time: u.reminderTime },
    groupWarning: u.groupWarning,
    dailyMessagePush: u.dailyMessagePush,
    showCountry: u.showCountry,
    weeklyGoal: u.weeklyGoal,
    createdAt: u.createdAt.toISOString(),
    entitlement: toEntitlement(e),
  };
}
export type Me = ReturnType<typeof toMe>;
