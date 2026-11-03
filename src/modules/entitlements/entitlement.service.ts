import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { betaGrants, entitlements, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { RealtimeBus } from '../../infra/realtime-bus';
import { K, REDIS } from '../../infra/redis';
import { toEntitlement } from '../me/me.mapper';
import { resolveAccess, type Access } from './access';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

/** Premium check for routes (spec §5.2): the JWT `prm` claim is only a hint, this is the source (Redis, never past an expiry). */
@Injectable()
export class EntitlementService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly bus: RealtimeBus) {}

  /** Paid entitlement + beta grant + account state, merged. Pass a transaction to read what that transaction just wrote. */
  async access(userId: string, db: DB | Tx = this.db): Promise<{ access: Access; rev: number; paid: typeof entitlements.$inferSelect | null }> {
    const [[u], [paid], [grant]] = await Promise.all([
      db.select({ s: users.suspendedAt, d: users.deletingAt, del: users.deletedAt, rev: users.accessRev }).from(users).where(eq(users.id, userId)),
      db.select().from(entitlements).where(eq(entitlements.userId, userId)),
      db.select().from(betaGrants).where(eq(betaGrants.userId, userId)),
    ]);
    const access = resolveAccess(paid, grant, { suspended: !!u?.s, deleting: !!u?.d || !!u?.del || !u });
    return { access, rev: u?.rev ?? 0, paid: paid ?? null };
  }

  async isActive(userId: string): Promise<boolean> {
    const hit = await this.redis.get(K.entitlement(userId)).catch(() => null);
    if (hit !== null) return hit === '1';
    const { access } = await this.access(userId);
    // a cached "yes" must not outlive the moment the access runs out
    const ttl = access.active && access.validUntil ? Math.min(60, Math.max(1, Math.floor((access.validUntil.getTime() - Date.now()) / 1000))) : 60;
    await this.redis.set(K.entitlement(userId), access.active ? '1' : '0', 'EX', ttl).catch(() => null);
    return access.active;
  }

  /** What the app sees: the paid entitlement fields, with beta access folded in and the account's current revision. */
  async view(userId: string, db: DB | Tx = this.db) {
    const { access, rev, paid } = await this.access(userId, db);
    return toEntitlement(paid, access, rev);
  }

  /**
   * Stamp a new revision and return the payload for `entitlement:changed`. Call it inside the transaction that changed
   * the access, then write the result to the outbox, so the event goes out only if the change committed.
   */
  async nextEvent(tx: Tx, userId: string) {
    await tx.update(users).set({ accessRev: sql`${users.accessRev} + 1` }).where(eq(users.id, userId));
    return { topic: 'entitlement:changed', payload: { userId, entitlement: await this.view(userId, tx) } };
  }

  /** Outside a transaction (webhooks, sync, expiry): drop the cache, stamp a revision, publish. */
  async publish(userId: string) {
    await this.invalidate(userId);
    const ev = await this.db.transaction((tx) => this.nextEvent(tx, userId));
    await this.bus.publish('entitlement:changed', ev.payload);
    return ev.payload.entitlement;
  }

  invalidate(userId: string) { return this.redis.del(K.entitlement(userId)); }
}
