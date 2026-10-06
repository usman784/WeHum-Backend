import { Body, Controller, Get, Headers, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminRoles, CurrentUser, RateLimit, type AppUser, type AuthedRequest } from '../../common/auth';
import { Zod } from '../../common/zod';
import { ALL_ROLES, CONTENT_ROLES } from '../admin-auth/rbac';
import { AnalyticsService } from './analytics.service';
import { DashboardService } from './dashboard.service';

const EventDto = z.object({
  name: z.string().regex(/^[a-z0-9_]{2,40}$/, 'lower case letters, digits and _'), key: z.string().max(80).optional(), at: z.string().datetime().optional(),
  props: z.record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).refine((p) => JSON.stringify(p).length <= 2000, 'Too large').optional(),
}).strict();
const BatchDto = z.object({ events: z.array(EventDto).min(1).max(50) }).strict();
const Period = z.object({ period: z.coerce.number().int().default(14), tz: z.enum(['UTC']).default('UTC') });

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('v1')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Fire and forget: 202 and nothing else for the app to wait on. */
  @RateLimit('analytics', 30, 60) @HttpCode(202) @Post('analytics/events')
  async ingest(@CurrentUser() u: AppUser, @Req() req: FastifyRequest, @Body(new Zod(BatchDto)) b: z.infer<typeof BatchDto>, @Headers('x-platform') platform?: string, @Headers('x-app-version') appVersion?: string) {
    void req;
    return { accepted: await this.analytics.ingest(u, b.events, { platform, appVersion }) };
  }
}

@ApiTags('Admin Analytics')
@ApiBearerAuth()
@Controller('v1/admin')
export class AnalyticsAdminController {
  constructor(private readonly analytics: AnalyticsService, private readonly dashboard: DashboardService) {}

  @AdminRoles(...ALL_ROLES) @Get('dashboard')
  get(@Req() req: AuthedRequest) { return this.dashboard.get(req.admin!.role); }

  @AdminRoles(...CONTENT_ROLES) @Get('analytics')
  trends(@Query(new Zod(Period)) q: z.infer<typeof Period>) { this.analytics.assertPeriod(q.period); return this.analytics.trends(q.period); }

  @AdminRoles(...CONTENT_ROLES) @Get('analytics/funnel')
  funnel(@Query(new Zod(Period)) q: z.infer<typeof Period>) { this.analytics.assertPeriod(q.period); return this.analytics.funnel(q.period); }

  @AdminRoles(...CONTENT_ROLES) @Get('analytics/retention')
  retention() { return this.analytics.retention(); }

  @AdminRoles(...CONTENT_ROLES) @Get('analytics/export')
  async export(@Query(new Zod(Period)) q: z.infer<typeof Period>, @Res() res: FastifyReply) {
    this.analytics.assertPeriod(q.period);
    const csv = await this.analytics.exportCsv(q.period);
    void res.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="wehum-analytics-${q.period}d.csv"`).send(csv);
  }
}
