import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../../infra/core.module';
import { REDIS } from '../../infra/redis';
import { Public } from '../../common/auth';
import { RAW } from '../../common/envelope.interceptor';

@Public()
@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(REDIS) private readonly redis: Redis) {}

  @Get('healthz') live() { return { [RAW]: true, ok: true }; }

  @Get('readyz')
  async ready(@Res({ passthrough: true }) res: FastifyReply) {
    const t = (p: Promise<unknown>) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000))]);
    const [db, redis] = await Promise.allSettled([t(this.pool.query('SELECT 1')), t(this.redis.ping())]);
    const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
    res.status(ok ? 200 : 503);
    return { [RAW]: true, ok, db: db.status === 'fulfilled', redis: redis.status === 'fulfilled' };
  }
}
