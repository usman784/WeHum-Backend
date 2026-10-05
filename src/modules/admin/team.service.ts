import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { AppError } from '../../common/errors';
import { adminSessions, adminUsers } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { v7 as uuid } from 'uuid';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import type { Role } from '../admin-auth/rbac';
import { AdminWriter, type Actor } from './admin-writer';

type A = typeof adminUsers.$inferSelect;
const view = (a: A) => ({ id: a.id, email: a.email, name: a.name, role: a.role, status: a.status, mfaEnabled: a.mfaEnabled, lastSignInAt: a.lastSignInAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString() });

@Injectable()
export class TeamService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter, private readonly adminAuth: AdminAuthService) {}

  async list() { return (await this.db.select().from(adminUsers).orderBy(asc(adminUsers.createdAt), asc(adminUsers.id))).map(view); }

  /** Admins may manage everyone except owners; only owners touch owners. */
  private guardTarget(actor: Actor, target: A, newRole?: Role) {
    if (actor.role !== 'owner' && (target.role === 'owner' || newRole === 'owner')) throw new AppError('FORBIDDEN', 'Only an owner can manage owners');
  }

  /** The last active owner can never be demoted, disabled or removed. */
  private async lastOwner(target: A) {
    if (target.role !== 'owner' || target.status !== 'active') return;
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(adminUsers).where(and(eq(adminUsers.role, 'owner'), eq(adminUsers.status, 'active'), ne(adminUsers.id, target.id))) as [{ n: number }];
    if (n === 0) throw new AppError('INVALID_STATE', 'There must always be one active owner');
  }

  private async get(id: string) {
    const [a] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, id));
    if (!a) throw new AppError('NOT_FOUND', 'Team member not found');
    return a;
  }

  async invite(actor: Actor, b: { email: string; name?: string; role: Role }) {
    if (actor.role !== 'owner' && b.role === 'owner') throw new AppError('FORBIDDEN', 'Only an owner can invite an owner');
    const [exists] = await this.db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, b.email));
    if (exists) throw new AppError('ALREADY_EXISTS', 'This email is already on the team');
    const id = uuid();
    const row = await this.writer.run(actor, { action: 'team.invite', type: 'admin', id }, async (tx) => {
      const [a] = await tx.insert(adminUsers).values({ id, email: b.email, name: b.name ?? b.email.split('@')[0]!, role: b.role, status: 'invited', invitedBy: actor.id ?? undefined }).returning();
      return { result: a!, after: { email: b.email, role: b.role } };
    });
    await this.adminAuth.sendLink(row, 'admin_invite', actor.id ?? undefined);
    return view(row);
  }

  async update(actor: Actor, id: string, b: { role?: Role; status?: 'active' | 'disabled'; name?: string }) {
    const t = await this.get(id);
    if (t.id === actor.id && (b.role || b.status === 'disabled')) throw new AppError('INVALID_STATE', 'You cannot change your own role or disable yourself');
    this.guardTarget(actor, t, b.role);
    if ((b.role && b.role !== 'owner') || b.status === 'disabled') await this.lastOwner(t);
    if (b.status === 'active' && t.status === 'invited') throw new AppError('INVALID_STATE', 'This person has not accepted the invitation yet');
    const patch = { ...(b.role && { role: b.role }), ...(b.status && { status: b.status }), ...(b.name && { name: b.name }) };
    if (!Object.keys(patch).length) return view(t);
    const row = await this.writer.run(actor, { action: 'team.update', type: 'admin', id }, async (tx) => {
      const [a] = await tx.update(adminUsers).set(patch).where(eq(adminUsers.id, id)).returning();
      return { result: a!, before: { role: t.role, status: t.status, name: t.name }, after: patch };
    });
    if (b.role || b.status === 'disabled') await this.adminAuth.revokeAll(id); // force_logout: new role applies on next refresh
    return view(row);
  }

  async remove(actor: Actor, id: string) {
    const t = await this.get(id);
    if (t.id === actor.id) throw new AppError('INVALID_STATE', 'You cannot remove yourself');
    this.guardTarget(actor, t);
    await this.lastOwner(t);
    await this.adminAuth.revokeAll(id);
    await this.writer.run(actor, { action: 'team.remove', type: 'admin', id }, async (tx) => {
      await tx.delete(adminSessions).where(eq(adminSessions.adminId, id));
      await tx.delete(adminUsers).where(eq(adminUsers.id, id));
      return { result: null, before: { email: t.email, role: t.role } };
    });
  }
}
