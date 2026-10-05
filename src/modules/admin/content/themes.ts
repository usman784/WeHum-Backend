import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Injectable, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { Zod } from '../../../common/zod';
import { sessions, themes } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES } from '../../admin-auth/rbac';
import { AdminWriter, changed, CurrentActor, etag, lockVersioned, type Actor } from '../admin-writer';
import { IdParam, ids, slugify, uuid as uuidDto } from '../dto';

const CreateDto = z.object({
  name: z.string().trim().min(1).max(60), subtitle: z.string().trim().max(120).nullable().optional(), description: z.string().max(2000).nullable().optional(),
  iconKey: z.string().max(40).nullable().optional(), visible: z.boolean().default(true),
}).strict();
const PatchDto = CreateDto.partial().strict();
const Order = z.object({ ids }).strict();
const DeleteQuery = z.object({ reassignTo: uuidDto.optional() });
type Row = typeof themes.$inferSelect;

@Injectable()
export class ThemesService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter) {}

  list() { return this.db.select().from(themes).orderBy(asc(themes.order), asc(themes.id)); }

  async create(actor: Actor, b: z.infer<typeof CreateDto>) {
    const id = uuid();
    return this.writer.run(actor, { action: 'theme.create', type: 'theme', id, catalog: true }, async (tx) => {
      const [{ next, taken }] = await tx.select({ next: sql<number>`coalesce(max(${themes.order}), -1) + 1`, taken: sql<number>`(count(*) filter (where ${themes.slug} = ${slugify(b.name)}))::int` }).from(themes) as [{ next: number; taken: number }];
      const slug = taken ? `${slugify(b.name)}-${id.slice(-4)}` : slugify(b.name);
      const [row] = await tx.insert(themes).values({ id, slug, order: next, ...b }).returning();
      return { result: row!, after: b, version: 1 };
    });
  }

  async patch(actor: Actor, id: string, b: z.infer<typeof PatchDto>, ifMatch?: string) {
    return this.writer.run(actor, { action: 'theme.update', type: 'theme', id, catalog: true }, async (tx) => {
      const cur = await lockVersioned<Row>(tx, themes, themes.id, id, ifMatch, 'Theme');
      const [row] = await tx.update(themes).set({ ...b, version: cur.version + 1, updatedAt: new Date() }).where(eq(themes.id, id)).returning();
      return { result: row!, ...changed(cur, { ...cur, ...b }), version: row!.version };
    });
  }

  /** The list must contain every theme exactly once. */
  async reorder(actor: Actor, order: string[]) {
    return this.writer.run(actor, { action: 'theme.reorder', type: 'theme', id: 'order', catalog: true }, async (tx) => {
      const all = await tx.select({ id: themes.id }).from(themes).for('update');
      if (all.length !== order.length || !all.every((t) => order.includes(t.id))) throw new AppError('VALIDATION_FAILED', 'Send every theme id exactly once');
      for (const [i, id] of order.entries()) await tx.update(themes).set({ order: i, updatedAt: new Date() }).where(eq(themes.id, id));
      return { result: order, after: { order } };
    }).then(() => this.list());
  }

  /** Themes that still have sessions need `reassignTo`; those sessions move there. */
  async remove(actor: Actor, id: string, reassignTo?: string) {
    await this.writer.run(actor, { action: 'theme.delete', type: 'theme', id, catalog: true }, async (tx) => {
      const [cur] = await tx.select().from(themes).where(eq(themes.id, id)).for('update');
      if (!cur) throw new AppError('NOT_FOUND', 'Theme not found');
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(sessions).where(eq(sessions.themeId, id)) as [{ n: number }];
      if (n > 0) {
        if (!reassignTo) throw new AppError('IN_USE', `${n} meditations use this theme. Choose a theme to move them to.`, { sessions: n });
        if (reassignTo === id) throw new AppError('VALIDATION_FAILED', 'reassignTo must be a different theme');
        const [target] = await tx.select({ id: themes.id }).from(themes).where(eq(themes.id, reassignTo));
        if (!target) throw new AppError('NOT_FOUND', 'Target theme not found');
        await tx.update(sessions).set({ themeId: reassignTo, updatedAt: new Date() }).where(eq(sessions.themeId, id));
      }
      await tx.delete(themes).where(eq(themes.id, id));
      return { result: null, before: { name: cur.name, slug: cur.slug }, after: { reassignedTo: reassignTo ?? null, sessionsMoved: n } };
    });
  }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin/themes')
export class ThemesController {
  constructor(private readonly themes: ThemesService) {}

  @Get() list() { return this.themes.list(); }

  @HttpCode(201) @Post()
  async create(@CurrentActor() a: Actor, @Body(new Zod(CreateDto)) b: z.infer<typeof CreateDto>, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.themes.create(a, b); res.header('etag', etag(row.version)); return row;
  }

  @Put('order')
  order(@CurrentActor() a: Actor, @Body(new Zod(Order)) b: z.infer<typeof Order>) { return this.themes.reorder(a, b.ids); }

  @Patch(':id')
  async patch(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Body(new Zod(PatchDto)) b: z.infer<typeof PatchDto>, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.themes.patch(a, id, b, ifMatch); res.header('etag', etag(row.version)); return row;
  }

  @HttpCode(204) @Delete(':id')
  async remove(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Query(new Zod(DeleteQuery)) q: z.infer<typeof DeleteQuery>) { await this.themes.remove(a, id, q.reassignTo); }
}
