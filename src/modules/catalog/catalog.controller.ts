import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser, RateLimit, type AppUser } from '../../common/auth';
import { CDN_CACHE, notModified, PRIVATE } from '../../common/etag';
import { Zod } from '../../common/zod';
import { CatalogService } from './catalog.service';

const Id = new Zod(z.string().uuid());
const SearchQuery = z.object({
  q: z.string().trim().min(2).max(60).optional(),
  themeId: z.string().uuid().optional(),
  type: z.enum(['audio', 'video', 'youtube']).optional(),
  access: z.enum(['free', 'premium']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

@ApiTags('Catalog')
@ApiBearerAuth()
@Controller('v1')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /** Full snapshot. `?version=n` equal to the current version (or a matching If-None-Match) → 304. */
  @Get('catalog')
  async snapshot(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply, @Query('version') clientVersion?: string) {
    const version = await this.catalog.version();
    res.header('vary', 'Accept-Encoding');
    const same = notModified(req, res, `"c${version}"`, CDN_CACHE);
    if (same) return;
    if (clientVersion !== undefined && Number(clientVersion) === version) { res.status(304); return; }
    return { data: await this.catalog.snapshot(version), meta: { version } };
  }

  @Get('sos')
  async sos(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const version = await this.catalog.version();
    if (notModified(req, res, `"sos${version}"`, PRIVATE)) return;
    return this.catalog.sos(version);
  }

  @Get('sessions/:id')
  async session(@Param('id', Id) id: string, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', PRIVATE);
    return this.catalog.sessionDetail(id, await this.catalog.version());
  }

  @Get('programs/:id')
  async program(@Param('id', Id) id: string, @CurrentUser() u: AppUser, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', PRIVATE);
    return this.catalog.programDetail(id, u.id, await this.catalog.version());
  }

  @Get('teachers/:id')
  async teacher(@Param('id', Id) id: string, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', PRIVATE);
    return this.catalog.teacherDetail(id, await this.catalog.version());
  }

  @RateLimit('search', 60, 60) @Get('search')
  search(@Query(new Zod(SearchQuery)) q: z.infer<typeof SearchQuery>) { return this.catalog.search(q); }
}
