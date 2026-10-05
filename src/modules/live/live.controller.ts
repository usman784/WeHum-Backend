import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
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
}
