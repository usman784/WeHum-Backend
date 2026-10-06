import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Account, CurrentUser, Member, RateLimit, type AppUser } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { CommunityService, REPORT_REASONS } from './community.service';

const PostDto = z.object({ meditationId: z.string().uuid(), text: z.string().max(400) }).strict(); // the 200-character limit is checked after trimming (below)
const ReportDto = z.object({ reason: z.enum(REPORT_REASONS), block: z.boolean().optional() }).strict();
const ListQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
const Id = new Zod(z.string().uuid());

@ApiTags('Community')
@ApiBearerAuth()
@Controller('v1')
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Get('sessions/:id/dedications')
  list(@CurrentUser() u: AppUser, @Param('id', Id) id: string, @Query(new Zod(ListQuery)) q: z.infer<typeof ListQuery>) { return this.community.list(u, id, q); }

  @Member() @Account() @RateLimit('dedication', 10, 60) @Post('dedications')
  post(@CurrentUser() u: AppUser, @Body(new Zod(PostDto)) b: z.infer<typeof PostDto>) {
    if (b.text.trim().length > 200) throw new AppError('VALIDATION_FAILED', 'At most 200 characters', { fields: [{ path: 'text', message: 'At most 200 characters' }] });
    return this.community.post(u, b);
  }

  @RateLimit('hold', 60, 60) @Put('dedications/:id/hold')
  hold(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { return this.community.hold(u, id, true); }

  @RateLimit('hold', 60, 60) @Delete('dedications/:id/hold')
  unhold(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { return this.community.hold(u, id, false); }

  @RateLimit('report', 20, 60) @HttpCode(200) @Post('dedications/:id/report')
  report(@CurrentUser() u: AppUser, @Param('id', Id) id: string, @Body(new Zod(ReportDto)) b: z.infer<typeof ReportDto>) { return this.community.report(u, id, b); }
}
