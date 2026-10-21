import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Account, CurrentUser, Member, RateLimit, type AppUser } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { CommunityService, REPORT_REASONS } from './community.service';

// Either a finished meditation (complete screen) or a session the person is looking at or playing (details, player): exactly one.
const PostDto = z.object({ meditationId: z.string().uuid().optional(), sessionId: z.string().uuid().optional(), text: z.string().max(400), locationMode: z.enum(['city', 'worldwide']).default('worldwide') }).strict() // the 200-character limit is checked after trimming (below)
  .refine((b) => !!b.meditationId !== !!b.sessionId, { message: 'Send meditationId or sessionId', path: ['sessionId'] });
const ReportDto = z.object({ reason: z.enum(REPORT_REASONS), block: z.boolean().optional() }).strict();
const ListQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
const Id = new Zod(z.string().uuid());
const TimeQuery = z.object({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm') });

@ApiTags('Community')
@ApiBearerAuth()
@Controller('v1')
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Get('sessions/:id/dedications')
  list(@CurrentUser() u: AppUser, @Param('id', Id) id: string, @Query(new Zod(ListQuery)) q: z.infer<typeof ListQuery>) { return this.community.list(u, id, q); }

  /** Together "Shared intent": the newest dedications across all meditations (everyone can read). */
  @Get('community/feed')
  feed(@CurrentUser() u: AppUser, @Query(new Zod(ListQuery)) q: z.infer<typeof ListQuery>) { return this.community.feed(u, q); }

  /** Sit-time screen: "N members sit together in this block". */
  @Get('community/members-at')
  membersAt(@Query(new Zod(TimeQuery)) q: z.infer<typeof TimeQuery>) { return this.community.membersAt(q.time); }

  /** Data & privacy: strip the name and place from my past dedications. */
  @HttpCode(200) @Post('me/dedications/anonymize')
  anonymize(@CurrentUser() u: AppUser) { return this.community.anonymize(u.id); }

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
