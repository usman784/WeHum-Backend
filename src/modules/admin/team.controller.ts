import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminRoles } from '../../common/auth';
import { Zod } from '../../common/zod';
import { MANAGER_ROLES } from '../admin-auth/rbac';
import { CurrentActor, type Actor } from './admin-writer';
import { TeamService } from './team.service';

const role = z.enum(['owner', 'admin', 'editor', 'moderator']);
const InviteDto = z.object({ email: z.string().trim().toLowerCase().email().max(254), name: z.string().trim().min(1).max(80).optional(), role }).strict();
const PatchDto = z.object({ role: role.optional(), status: z.enum(['active', 'disabled']).optional(), name: z.string().trim().min(1).max(80).optional() }).strict();
const Id = new Zod(z.string().uuid());

@ApiTags('Admin Team')
@ApiBearerAuth()
@AdminRoles(...MANAGER_ROLES)
@Controller('v1/admin/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get() list() { return this.team.list(); }

  @HttpCode(201) @Post('invite')
  invite(@CurrentActor() a: Actor, @Body(new Zod(InviteDto)) b: z.infer<typeof InviteDto>) { return this.team.invite(a, b); }

  @Patch(':id')
  update(@CurrentActor() a: Actor, @Param('id', Id) id: string, @Body(new Zod(PatchDto)) b: z.infer<typeof PatchDto>) { return this.team.update(a, id, b); }

  @HttpCode(204) @Delete(':id')
  async remove(@CurrentActor() a: Actor, @Param('id', Id) id: string) { await this.team.remove(a, id); }
}
