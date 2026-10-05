import type { AdminClaims } from '../auth/tokens.service';

export type Role = AdminClaims['role'];
export const ALL_ROLES: Role[] = ['owner', 'admin', 'editor', 'moderator'];
export const CONTENT_ROLES: Role[] = ['owner', 'admin', 'editor'];
export const MANAGER_ROLES: Role[] = ['owner', 'admin'];
export const MODERATION_ROLES: Role[] = ['owner', 'admin', 'moderator'];

/** Capabilities the CMS reads from GET /v1/admin/me (CMS spec §6.2). The API enforces them; the UI only hides things. */
export function permissionsFor(role: Role): string[] {
  const p: string[] = ['dashboard'];
  if (role !== 'moderator') p.push('analytics', 'content.write', 'subscriptions.read', 'users.read', 'push.draft');
  if (role === 'moderator') p.push('moderation.stats');
  if (role !== 'editor') p.push('moderation');
  if (role === 'owner' || role === 'admin') p.push('users.write', 'push.send', 'settings', 'team.manage', 'audit.read');
  return p;
}
