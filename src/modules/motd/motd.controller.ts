import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Member } from '../../common/auth';
import { Zod } from '../../common/zod';
import { addDaysIso, MotdService, utcToday } from './motd.service';

const DateParam = new Zod(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d), 'Invalid date'));
const ArchiveQuery = z.object({ q: z.string().trim().min(1).max(60).optional(), theme: z.string().max(40).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });

@ApiTags('Today')
@ApiBearerAuth()
@Controller('v1')
export class MotdController {
  constructor(private readonly motd: MotdService) {}

  @Get('motd/:date')
  one(@Param('date', DateParam) date: string) {
    const max = addDaysIso(utcToday(), 1);
    return this.motd.forDate(date > max ? max : date);
  }

  @Member() @Get('daily-messages')
  archive(@Query(new Zod(ArchiveQuery)) q: z.infer<typeof ArchiveQuery>) { return this.motd.archive(q); }

  @Member() @Get('daily-messages/:date')
  message(@Param('date', DateParam) date: string) { return this.motd.messageFor(date); }
}
