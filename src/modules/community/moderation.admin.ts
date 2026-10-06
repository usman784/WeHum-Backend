import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminRoles } from '../../common/auth';
import { Zod } from '../../common/zod';
import { MANAGER_ROLES, MODERATION_ROLES } from '../admin-auth/rbac';
import { AdminWriter, CurrentActor, etag, type Actor } from '../admin/admin-writer';
import { CONFIG_SCHEMAS, ConfigAdminService } from '../admin/content/config';
import { ids } from '../admin/dto';
import { CommunityService } from './community.service';

const Queue = z.object({ filter: z.enum(['review', 'flagged', 'hidden', 'all']).default('review'), sessionId: z.string().uuid().optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
const Bulk = z.object({ ids: ids, action: z.enum(['hide', 'keep']) }).strict();
const MuteDto = z.object({ muted: z.boolean().default(true) }).strict();
const Id = new Zod(z.string().uuid());

@ApiTags('Admin Moderation')
@ApiBearerAuth()
@AdminRoles(...MODERATION_ROLES)
@Controller('v1/admin')
export class ModerationAdminController {
  constructor(private readonly community: CommunityService, private readonly writer: AdminWriter, private readonly config: ConfigAdminService) {}

  @Get('moderation') queue(@Query(new Zod(Queue)) q: z.infer<typeof Queue>) { return this.community.queue(q); }
  @Get('moderation/stats') stats() { return this.community.stats(); }

  private async decide(a: Actor, id: string, action: 'hide' | 'keep') {
    const out = await this.writer.run(a, { action: `moderation.${action}`, type: 'dedication', id }, async () => {
      const r = await this.community.decide(a.id!, id, action);
      return { result: r, before: { status: r.before }, after: { status: r.after, autoMuted: r.autoMuted } };
    });
    await this.community.announceCount();
    return { id, status: out.after, autoMuted: out.autoMuted };
  }

  @HttpCode(200) @Post('moderation/bulk')
  async bulk(@CurrentActor() a: Actor, @Body(new Zod(Bulk)) b: z.infer<typeof Bulk>) {
    const results: { id: string; ok: boolean; status?: string; error?: string }[] = [];
    for (const id of b.ids) {
      try { results.push({ id, ok: true, status: (await this.decide(a, id, b.action)).status }); } catch (e) { results.push({ id, ok: false, error: (e as Error).message }); }
    }
    return { results };
  }

  @HttpCode(200) @Post('moderation/:id/hide') hide(@CurrentActor() a: Actor, @Param('id', Id) id: string) { return this.decide(a, id, 'hide'); }
  @HttpCode(200) @Post('moderation/:id/keep') keep(@CurrentActor() a: Actor, @Param('id', Id) id: string) { return this.decide(a, id, 'keep'); }

  @HttpCode(200) @Post('users/:id/mute')
  mute(@CurrentActor() a: Actor, @Param('id', Id) id: string, @Body(new Zod(MuteDto)) b: z.infer<typeof MuteDto>) {
    return this.writer.run(a, { action: b.muted ? 'user.mute' : 'user.unmute', type: 'user', id }, async () => ({ result: await this.community.setMuted(id, b.muted), after: { muted: b.muted } }));
  }

  @Get('moderation/rules')
  async rules(@Res({ passthrough: true }) res: FastifyReply) { const c = await this.config.get('moderation'); res.header('etag', etag(c.version)); return c; }

  @AdminRoles(...MANAGER_ROLES) @Put('moderation/rules')
  async saveRules(@CurrentActor() a: Actor, @Body() body: unknown, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const out = await this.config.put(a, 'moderation', CONFIG_SCHEMAS.moderation.parse(body ?? {}), m);
    res.header('etag', etag(out.version));
    return out;
  }
}
