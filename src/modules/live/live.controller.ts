import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Public, RateLimit } from '../../common/auth';
import { Zod } from '../../common/zod';
import { utcToday } from '../motd/motd.service';
import { LiveService } from './live.service';

const Query_ = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

@ApiTags('Today')
@ApiBearerAuth()
@Controller('v1')
export class LiveController {
  constructor(private readonly live: LiveService) {}

  /** Snapshot for when the socket is down. */
  @Get('live')
  snapshot(@Query(new Zod(Query_)) q: z.infer<typeof Query_>, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'private, no-store');
    return this.live.snapshot(q.date ?? utcToday());
  }

  /** CMS sign-in page (before login): two totals, no countries, nothing per user. Cached for 10 s. */
  @Public() @RateLimit('public-live', 30, 60) @Get('admin/public/live')
  async publicLive(@Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'public, max-age=10');
    const s = await this.live.snapshot(utcToday());
    return { meditatedToday: s.meditatedToday, meditatingNow: s.total, at: s.at };
  }
}
