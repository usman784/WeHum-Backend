import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, type AppUser } from '../../common/auth';
import { PRIVATE } from '../../common/etag';
import { Zod } from '../../common/zod';
import { ConfigService, type MainConfig } from '../config/config.service';
import { ProgressService } from './progress.service';

const Q = z.object({ period: z.enum(['week', 'month', 'year', 'all']).default('week') });

@ApiTags('Me')
@ApiBearerAuth()
@Controller('v1/me')
export class ProgressController {
  constructor(private readonly progress: ProgressService, private readonly config: ConfigService) {}

  @Get('progress')
  async get(@CurrentUser() u: AppUser, @Query(new Zod(Q)) q: z.infer<typeof Q>, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', PRIVATE);
    const [{ tz, weeklyGoal }, main] = await Promise.all([this.progress.profile(u.id), this.config.value<MainConfig>('main')]);
    const [base, lifetime, streak] = await Promise.all([
      this.progress.progress(u.id, tz, q.period),
      this.progress.lifetime(u.id),
      main.features?.streaks === false ? null : this.progress.streak(u.id, tz, weeklyGoal),
    ]);
    return { ...base, lifetime, streak };
  }
}
