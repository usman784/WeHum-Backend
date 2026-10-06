import { Body, Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { CurrentUser, Public, RateLimit, type AppUser } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { env } from '../../config/env';
import { subscriptionEvents } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { QUEUES, QueueService } from '../../jobs/queues';
import { toEntitlement } from '../me/me.mapper';
import { metrics } from '../../infra/metrics';
import { RcProcessor } from './rc.processor';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const Hook = z.object({
  event: z.object({ id: z.string().min(1).max(80), type: z.string().min(1).max(40), event_timestamp_ms: z.number().int() }).passthrough(),
}).passthrough();

/** RevenueCat → us. Answers fast: the event is stored (idempotent by id) and processed by the worker. */
@ApiExcludeController()
@Controller()
export class RevenueCatWebhookController {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly queues: QueueService, private readonly processor: RcProcessor) {}

  @Public() @HttpCode(200) @Post('webhooks/revenuecat')
  async hook(@Headers('authorization') auth: string | undefined, @Body(new Zod(Hook)) body: z.infer<typeof Hook>) {
    const secret = env.REVENUECAT_WEBHOOK_SECRET;
    const given = (auth ?? '').replace(/^Bearer\s+/i, '');
    if (!secret || !same(given, secret)) { metrics.rcWebhook.inc({ type: 'unknown', status: 'unauthorized' }); throw new AppError('AUTH_REQUIRED', 'Bad webhook secret'); }
    const e = body.event as Record<string, unknown> & { id: string; type: string; event_timestamp_ms: number; product_id?: string; period_type?: string; store?: string; price?: number; currency?: string };
    const [row] = await this.db.insert(subscriptionEvents).values({
      id: e.id, type: e.type, productId: e.product_id ?? null, periodType: e.period_type?.toLowerCase() ?? null, priceUsd: e.price != null ? String(e.price) : null,
      currency: e.currency?.slice(0, 3) ?? null, store: e.store ?? null, eventAt: new Date(e.event_timestamp_ms), raw: body as object,
    }).onConflictDoNothing().returning({ id: subscriptionEvents.id });
    if (row) await this.queues.add(QUEUES.cron, 'rc.process', { eventId: e.id }, { jobId: `rc-${e.id}`, attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
    metrics.rcWebhook.inc({ type: e.type, status: row ? 'queued' : 'duplicate' });
    return { ok: true, duplicate: !row };
  }
}

/** The app asks for a re-read right after a purchase, in case the webhook is late. */
@Controller('v1/me')
export class EntitlementSyncController {
  constructor(private readonly processor: RcProcessor) {}

  @RateLimit('ent-sync', 6, 60) @HttpCode(200) @Post('entitlement/sync')
  async sync(@CurrentUser() u: AppUser) {
    return toEntitlement(await this.processor.syncUser(u.id));
  }
}
