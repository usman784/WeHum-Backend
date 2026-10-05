import { Body, Controller, Get, Headers, Inject, Injectable, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { Zod } from '../../../common/zod';
import { sessions } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES } from '../../admin-auth/rbac';
import { AdminWriter, CurrentActor, etag, type Actor } from '../admin-writer';
import { ids } from '../dto';
import { CONFIG_SCHEMAS, ConfigAdminService } from './config';

const OrderDto = z.object({ ids: ids.refine((a) => a.length <= 8, 'At most 8 tiles') }).strict();

@Injectable()
export class SosAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter, private readonly config: ConfigAdminService) {}

  /** Header + help card (config) and the tiles (sessions flagged `is_sos`). */
  async get() {
    const [cfg, tiles] = await Promise.all([
      this.config.get('sos'),
      this.db.select().from(sessions).where(eq(sessions.isSos, true)).orderBy(asc(sessions.sosOrder), asc(sessions.id)),
    ]);
    return {
      ...cfg,
      tiles: tiles.map((s) => ({ sessionId: s.id, title: s.title, feeling: s.sosFeeling ?? s.title, subtitle: s.sosSubtitle, durationSec: s.durationSec, status: s.status, order: s.sosOrder })),
    };
  }

  /** The given sessions become the tiles, in this order; anything else stops being a tile. Max 8. */
  async reorder(actor: Actor, order: string[]) {
    await this.writer.run(actor, { action: 'sos.reorder', type: 'sos', id: 'order', catalog: true }, async (tx) => {
      const found = await tx.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, order)).for('update');
      if (found.length !== order.length) throw new AppError('NOT_FOUND', 'Unknown meditation in the list');
      await tx.update(sessions).set({ isSos: false, sosOrder: null, updatedAt: new Date() }).where(eq(sessions.isSos, true));
      for (const [i, id] of order.entries()) await tx.update(sessions).set({ isSos: true, sosOrder: i, updatedAt: new Date() }).where(eq(sessions.id, id));
      return { result: null, after: { order } };
    });
    return this.get();
  }

  save(actor: Actor, body: unknown, ifMatch?: string) { return this.config.put(actor, 'sos', CONFIG_SCHEMAS.sos.parse(body ?? {}), ifMatch); }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin/sos')
export class SosAdminController {
  constructor(private readonly sos: SosAdminService) {}

  @Get() async get(@Res({ passthrough: true }) res: FastifyReply) { const out = await this.sos.get(); res.header('etag', etag(out.version)); return out; }

  @Put()
  async put(@CurrentActor() a: Actor, @Body() b: unknown, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const out = await this.sos.save(a, b, m); res.header('etag', etag(out.version)); return out;
  }

  @Put('order')
  order(@CurrentActor() a: Actor, @Body(new Zod(OrderDto)) b: z.infer<typeof OrderDto>) { return this.sos.reorder(a, b.ids); }
}
