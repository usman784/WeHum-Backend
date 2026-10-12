import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type AppUser } from '../../common/auth';
import { EntitlementService } from '../entitlements/entitlement.service';
import { Zod } from '../../common/zod';
import { addDaysIso, MotdService, utcToday } from './motd.service';

const DateParam = new Zod(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => { const t = Date.parse(d); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); }, 'Invalid date'));
const ArchiveQuery = z.object({ q: z.string().trim().min(1).max(60).optional(), theme: z.string().max(40).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });

@ApiTags('Today')
@ApiBearerAuth()
@Controller('v1')
export class MotdController {
  constructor(private readonly motd: MotdService, private readonly entitlements: EntitlementService) {}

  @Get('motd/:date')
  one(@Param('date', DateParam) date: string) {
    const max = addDaysIso(utcToday(), 1);
    return this.motd.forDate(date > max ? max : date);
  }

  /** Everyone sees the archive; premium rows are `locked` for free users (Stitch: "Unlock"). */
  @Get('daily-messages')
  async archive(@CurrentUser() u: AppUser, @Query(new Zod(ArchiveQuery)) q: z.infer<typeof ArchiveQuery>) { return this.motd.archive(q, await this.entitlements.isActive(u.id)); }

  /** Free messages open for everyone, premium ones need a membership (403 PREMIUM_REQUIRED). */
  @Get('daily-messages/:date')
  async message(@CurrentUser() u: AppUser, @Param('date', DateParam) date: string) {
    return this.motd.messageFor(date, { userId: u.id, member: await this.entitlements.isActive(u.id) });
  }

  @HttpCode(200) @Post('daily-messages/:date/complete')
  complete(@CurrentUser() u: AppUser, @Param('date', DateParam) date: string) { return this.motd.markListened(date, u.id); }

  @Put('daily-messages/:date/save')
  save(@CurrentUser() u: AppUser, @Param('date', DateParam) date: string) { return this.motd.save(u.id, date, true); }

  @Delete('daily-messages/:date/save')
  unsave(@CurrentUser() u: AppUser, @Param('date', DateParam) date: string) { return this.motd.save(u.id, date, false); }
}
