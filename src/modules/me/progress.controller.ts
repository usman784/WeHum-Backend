import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, type AppUser } from '../../common/auth';
import { PRIVATE } from '../../common/etag';
import { Zod } from '../../common/zod';
import { ProgressService } from './progress.service';

const Q = z.object({ period: z.enum(['week', 'month', 'year', 'all']).default('week') });

@ApiTags('Me')
@ApiBearerAuth()
@Controller('v1/me')
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  @Get('progress')
  async get(@CurrentUser() u: AppUser, @Query(new Zod(Q)) q: z.infer<typeof Q>, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', PRIVATE);
    return this.progress.progress(u.id, await this.progress.tz(u.id), q.period);
  }
}
