import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { entitlements } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';

/** Premium check for routes (spec §5.2): the JWT `prm` claim is only a hint, this is the source (Redis 60 s). */
@Injectable()
export class EntitlementService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis) {}

  async isActive(userId: string): Promise<boolean> {
    const hit = await this.redis.get(K.entitlement(userId)).catch(() => null);
    if (hit !== null) return hit === '1';
    const [e] = await this.db.select({ active: entitlements.active, expiresAt: entitlements.expiresAt }).from(entitlements).where(eq(entitlements.userId, userId));
    const active = !!e?.active && (!e.expiresAt || e.expiresAt > new Date());
    await this.redis.set(K.entitlement(userId), active ? '1' : '0', 'EX', 60).catch(() => null);
    return active;
  }

  invalidate(userId: string) { return this.redis.del(K.entitlement(userId)); }
}
