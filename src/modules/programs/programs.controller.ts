import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, Member, type AppUser } from '../../common/auth';
import { Zod } from '../../common/zod';
import { ProgramsUserService } from './programs-user.service';

const Id = new Zod(z.string().uuid());
const Day = new Zod(z.coerce.number().int().min(1).max(60));

@ApiTags('Programs')
@ApiBearerAuth()
@Member()
@Controller('v1/programs')
export class ProgramsController {
  constructor(private readonly programs: ProgramsUserService) {}

  @HttpCode(200) @Post(':id/start')
  start(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { return this.programs.start(u.id, id); }

  @HttpCode(200) @Post(':id/days/:day/complete')
  complete(@CurrentUser() u: AppUser, @Param('id', Id) id: string, @Param('day', Day) day: number) { return this.programs.complete(u.id, id, day); }
}
