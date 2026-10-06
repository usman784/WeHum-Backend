import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Account, CurrentUser, Member, RateLimit, type AppUser } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { REPORT_REASONS } from '../community/community.service';
import { ComingSoonService } from './coming-soon.service';
import { patternProblem } from './rules';

const Kind = z.enum(['gratitude', 'affirmation', 'love']);
const FeedQuery = z.object({ kind: Kind.default('gratitude'), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
const ShareDto = z.object({ kind: Kind.default('gratitude'), text: z.string().max(400) }).strict(); // 200 characters after trimming
const ReportDto = z.object({ reason: z.enum(REPORT_REASONS), block: z.boolean().optional() }).strict();
const Beat = z.number().int().min(0).max(20);
const PatternDto = z.object({ name: z.string().trim().min(1).max(40), inhaleSec: Beat, hold1Sec: Beat.default(0), exhaleSec: Beat, hold2Sec: Beat.default(0), rounds: z.number().int().min(1).max(100).default(10) }).strict();
const Id = new Zod(z.string().uuid());

/** P11 "coming soon" for the app. Every route answers `404 FEATURE_OFF` while its flag is off. */
@ApiTags('Coming soon')
@ApiBearerAuth()
@Controller('v1')
export class ComingSoonController {
  constructor(private readonly svc: ComingSoonService) {}

  // challenges (app 69)
  @Get('challenges') challenges(@CurrentUser() u: AppUser) { return this.svc.challenges(u); }
  @RateLimit('challenge', 20, 60) @HttpCode(200) @Post('challenges/:id/join') join(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { return this.svc.join(u, id); }
  @RateLimit('challenge', 20, 60) @Delete('challenges/:id/join') leave(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { return this.svc.leave(u, id); }

  // gratitude feed (app 70)
  @Get('gratitude') feed(@CurrentUser() u: AppUser, @Query(new Zod(FeedQuery)) q: z.infer<typeof FeedQuery>) { return this.svc.feed(u, q); }
  @Member() @Account() @RateLimit('gratitude', 10, 60) @Post('gratitude') share(@CurrentUser() u: AppUser, @Body(new Zod(ShareDto)) b: z.infer<typeof ShareDto>) { return this.svc.share(u, b); }
  @RateLimit('report', 20, 60) @HttpCode(200) @Post('gratitude/:id/report')
  report(@CurrentUser() u: AppUser, @Param('id', Id) id: string, @Body(new Zod(ReportDto)) b: z.infer<typeof ReportDto>) { return this.svc.reportPost(u, id, b); }

  // breathwork (app 71, 72)
  @Get('breathwork') breathwork() { return this.svc.breathwork(); }
  @Get('me/breath-patterns') myPatterns(@CurrentUser() u: AppUser) { return this.svc.myPatterns(u); }
  @RateLimit('breath', 20, 60) @Post('me/breath-patterns')
  save(@CurrentUser() u: AppUser, @Body(new Zod(PatternDto)) b: z.infer<typeof PatternDto>) {
    const problem = patternProblem(b);
    if (problem) throw new AppError('VALIDATION_FAILED', problem, { fields: [{ path: 'inhaleSec', message: problem }] });
    return this.svc.savePattern(u, b);
  }
  @HttpCode(204) @Delete('me/breath-patterns/:id') async remove(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { await this.svc.deletePattern(u, id); }

  // milestones (app 73)
  @Get('me/milestones') milestones(@CurrentUser() u: AppUser) { return this.svc.milestones(u); }
}
