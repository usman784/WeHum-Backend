import { Controller, Get, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { LibraryService } from './library.service';

@ApiTags('Catalog')
@ApiBearerAuth()
@Controller('v1/library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  /** Library header numbers and "sat today" counts (Stitch Library A/B). */
  @Get('summary')
  summary(@Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'private, max-age=30');
    return this.library.summary();
  }
}
