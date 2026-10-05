import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { createDb, createPool, type DB } from '../db/client';
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
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown() {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}

export type { DB };
