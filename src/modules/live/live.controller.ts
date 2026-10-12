import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { asc, eq, and } from 'drizzle-orm';
import { Public, RateLimit } from '../../common/auth';
import { soundBlocks } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { ConfigService, type SilenceConfig, type TodayConfig } from '../config/config.service';
import { Zod } from '../../common/zod';
import { utcToday } from '../motd/motd.service';
import { LiveService } from './live.service';

const Query_ = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

@ApiTags('Today')
@ApiBearerAuth()
@Controller('v1')
export class LiveController {
  constructor(private readonly live: LiveService, private readonly config: ConfigService, @Inject(DRIZZLE) private readonly db: DB) {}

  /** Snapshot for when the socket is down. */
  @Get('live')
  snapshot(@Query(new Zod(Query_)) q: z.infer<typeof Query_>, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'private, no-store');
    return this.live.snapshot(q.date ?? utcToday());
  }

  /**
   * Silence Room setup (Stitch): people sitting in silence now by belt, today's total and zones for the quiet variant,
   * durations, the 4/6 cadence, and the bells to choose from. Anyone can read it; starting is a member feature.
   */
  @Get('silence')
  async silence(@Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'private, max-age=5');
    const [live, cfg, today, bells] = await Promise.all([
      this.live.silence(), this.config.value<SilenceConfig>('silence'), this.config.value<TodayConfig>('today'),
      this.db.select().from(soundBlocks).where(and(eq(soundBlocks.kind, 'bell'), eq(soundBlocks.visible, true))).orderBy(asc(soundBlocks.order), asc(soundBlocks.id)),
    ]);
    const pick = (role: 'opening' | 'interval' | 'closing') => bells.filter((b) => !b.bellRole || b.bellRole === role).map((b) => ({ id: b.id, name: b.name, durationSec: b.durationSec, access: b.access }));
    return {
      sittingNow: live.people, belts: live.belts, quiet: live.quiet, emptyRoomThreshold: today.emptyRoomThreshold,
      todayTotal: live.todayTotal, todayZones: live.todayZones,
      durations: cfg.durations, cadence: cfg.cadence, extendMin: cfg.extendMin,
      bells: { opening: pick('opening'), interval: pick('interval'), closing: pick('closing') },
    };
  }

  /** World gauge (Stitch): totals, belts and the country list, from country codes only. */
  @Get('live/world')
  async world(@Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'private, max-age=5');
    return this.live.world();
  }

  /** CMS sign-in page (before login): two totals, no countries, nothing per user. Cached for 10 s. */
  @Public() @RateLimit('public-live', 30, 60) @Get('admin/public/live')
  async publicLive(@Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'public, max-age=10');
    const s = await this.live.snapshot(utcToday());
    const b = await this.config.branding();
    return { meditatedToday: s.meditatedToday, meditatingNow: s.total, at: s.at, branding: { appName: b.appName, logoUrl: b.logoUrl } };
  }
}
