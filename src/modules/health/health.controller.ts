import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../../infra/core.module';
import { REDIS } from '../../infra/redis';
import { Public } from '../../common/auth';
import { RAW } from '../../common/envelope.interceptor';
import { metricsAllowed, render } from '../../infra/metrics';

@Public()
@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(REDIS) private readonly redis: Redis) {}

  @Get('healthz') live() { return { [RAW]: true, ok: true }; }

  /** Prometheus (spec §11). Needs `Authorization: Bearer METRICS_TOKEN` when the token is set; off in staging/prod without it. */
  @Get('metrics')
  async metrics(@Headers('authorization') auth: string | undefined, @Res() res: FastifyReply) {
    const allowed = metricsAllowed(auth);
    if (allowed !== 'ok') return void res.status(allowed === 'off' ? 404 : 401).send();
    const m = await render();
    void res.header('content-type', m.contentType).send(m.body);
  }

  @Get('readyz')
  async ready(@Res({ passthrough: true }) res: FastifyReply) {
    const t = (p: Promise<unknown>) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000))]);
    const [db, redis] = await Promise.allSettled([t(this.pool.query('SELECT 1')), t(this.redis.ping())]);
    const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
    res.status(ok ? 200 : 503);
    return { [RAW]: true, ok, db: db.status === 'fulfilled', redis: redis.status === 'fulfilled' };
  }
}
