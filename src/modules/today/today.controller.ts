import { Body, Controller, Get, Headers, HttpCode, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser, SkipVersionGate, type AppUser } from '../../common/auth';
import { notModified, PRIVATE } from '../../common/etag';
import { Zod } from '../../common/zod';
import { GroupService, SLOT } from './group.service';
import { TodayService } from './today.service';

const IntentionDto = z.object({ slot: z.string().regex(SLOT), intention: z.string().trim().min(1).max(60) }).strict();
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

  /** The next group sit with its cadence, intentions, "today's focus" and how many people wait in each belt. */
  @Get('group/next')
  async next(@CurrentUser() u: AppUser, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', PRIVATE);
    return this.today.nextGroup(u);
  }

  /** Saves the person's intention for a sit (one of the configured options). */
  @HttpCode(200) @Put('group/intention')
  intention(@CurrentUser() u: AppUser, @Body(new Zod(IntentionDto)) b: z.infer<typeof IntentionDto>) { return this.today.setIntention(u, b.slot, b.intention); }
}
