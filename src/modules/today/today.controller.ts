import { Controller, Get, Headers, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser, SkipVersionGate, type AppUser } from '../../common/auth';
import { notModified, PRIVATE } from '../../common/etag';
import { Zod } from '../../common/zod';
import { GroupService } from './group.service';
import { TodayService } from './today.service';

const TodayQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => { const t = Date.parse(d); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); }, 'Invalid date').optional() });

@ApiTags('Today')
@ApiBearerAuth()
@Controller('v1')
export class TodayController {
  constructor(private readonly today: TodayService, private readonly group: GroupService) {}

  @SkipVersionGate() @Get('bootstrap')
  async bootstrap(@CurrentUser() u: AppUser, @Headers('x-app-version') version: string | undefined, @Headers('x-platform') platform: string | undefined, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const { etag, body } = await this.today.bootstrap(u, { version, platform });
    if (notModified(req, res, etag, PRIVATE)) return;
    return body;
  }

  @Get('today')
  async get(@CurrentUser() u: AppUser, @Query(new Zod(TodayQuery)) q: z.infer<typeof TodayQuery>, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const { etag, body } = await this.today.today(u, q.date);
    if (notModified(req, res, etag, PRIVATE)) return;
    return body;
  }

  @Get('group/next')
  async next(@Res({ passthrough: true }) res: FastifyReply) { res.header('cache-control', PRIVATE); return this.group.next(); }
}
