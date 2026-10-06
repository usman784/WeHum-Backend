import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { createDb, createPool, type DB } from '../db/client';
import { metrics, onScrape } from './metrics';
import { RealtimeBus } from './realtime-bus';
import { createRedis, REDIS } from './redis';

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

/** Postgres pool + Drizzle + Redis, shared by every module. */
@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: () => createPool() },
    { provide: DRIZZLE, inject: [PG_POOL], useFactory: (p: Pool) => createDb(p) },
    { provide: REDIS, useFactory: () => createRedis() },
    RealtimeBus,
  ],
  exports: [PG_POOL, DRIZZLE, REDIS, RealtimeBus],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(REDIS) private readonly redis: Redis) {
    onScrape(async () => {
      metrics.dbPoolInUse.set(pool.totalCount - pool.idleCount);
      // oldest event the relay has not published yet (0 when it is caught up)
      const r = await pool.query<{ ms: number | null }>(`SELECT (extract(epoch FROM now() - min(created_at)) * 1000)::float8 AS ms FROM outbox_events WHERE published_at IS NULL`);
      metrics.outboxLag.set(r.rows[0]?.ms ?? 0);
    });
  }
  async onApplicationShutdown() {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}

export type { DB };
