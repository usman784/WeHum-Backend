import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, RateLimit, type AppUser } from '../../common/auth';
import { Zod } from '../../common/zod';
import { BatchDto, MeditationDto, MeditationsService, type MeditationInput } from './meditations.service';

const HistoryQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });

@ApiTags('Meditations')
@ApiBearerAuth()
@Controller('v1')
export class MeditationsController {
  constructor(private readonly meditations: MeditationsService) {}

  /** 201 when new, 200 with the same payload when the client id was already recorded. */
  @Post('meditations')
  async record(@CurrentUser() u: AppUser, @Body(new Zod(MeditationDto)) b: MeditationInput, @Res({ passthrough: true }) res: FastifyReply) {
    const { created, result } = await this.meditations.record(u, b);
    res.status(created ? 201 : 200);
    return result;
  }

  @RateLimit('batch', 20, 60) @HttpCode(200) @Post('meditations/batch')
  batch(@CurrentUser() u: AppUser, @Body(new Zod(BatchDto)) b: z.infer<typeof BatchDto>) { return this.meditations.batch(u, b.items); }

  @Get('meditations')
  history(@CurrentUser() u: AppUser, @Query(new Zod(HistoryQuery)) q: z.infer<typeof HistoryQuery>) { return this.meditations.history(u.id, q); }

  /** Payoff "Send kudos to all" (Stitch). */
  @RateLimit('kudos', 20, 60) @HttpCode(200) @Post('sessions/:id/kudos')
  kudos(@CurrentUser() u: AppUser, @Param('id', new Zod(z.string().uuid())) id: string) { return this.meditations.kudos(u, id); }
}
