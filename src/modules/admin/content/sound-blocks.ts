import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { Zod } from '../../../common/zod';
import { soundBlocks } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES } from '../../admin-auth/rbac';
import { AdminWriter, changed, CurrentActor, etag, lockVersioned, type Actor } from '../admin-writer';
import { IdParam, ids, uuid as uuidDto } from '../dto';
import { readyMedia } from '../media-check';

const kind = z.enum(['opening', 'core', 'closing', 'sound', 'bell', 'loop']);
const CreateDto = z.object({
  kind, name: z.string().trim().min(1).max(80), mediaId: uuidDto, loopable: z.boolean().default(false),
  access: z.enum(['free', 'premium']).default('premium'), visible: z.boolean().default(true),
}).strict();
const PatchDto = z.object({ name: z.string().trim().min(1).max(80), mediaId: uuidDto, loopable: z.boolean(), access: z.enum(['free', 'premium']), visible: z.boolean(), kind }).partial().strict();
const OrderDto = z.object({ ids }).strict();
const ListQuery = z.object({ kind: kind.optional() });
type Row = typeof soundBlocks.$inferSelect;

@Injectable()
export class SoundBlocksService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter) {}

  list(k?: z.infer<typeof kind>) {
    return this.db.select().from(soundBlocks).where(k ? eq(soundBlocks.kind, k) : undefined).orderBy(asc(soundBlocks.kind), asc(soundBlocks.order), asc(soundBlocks.id));
  }

  /** Duration and loudness come from the processed media file, never from the form. */
  async create(actor: Actor, b: z.infer<typeof CreateDto>) {
    const media = await readyMedia(this.db, b.mediaId, ['audio']);
    const id = uuid();
    return this.writer.run(actor, { action: 'soundBlock.create', type: 'soundBlock', id, catalog: true }, async (tx) => {
      const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${soundBlocks.order}), -1) + 1` }).from(soundBlocks).where(eq(soundBlocks.kind, b.kind)) as [{ next: number }];
      const [row] = await tx.insert(soundBlocks).values({ id, ...b, order: next, durationSec: media.durationSec ?? 0, loudnessLufs: media.loudnessLufs }).returning();
      return { result: row!, after: b, version: 1 };
    });
  }

  async patch(actor: Actor, id: string, b: z.infer<typeof PatchDto>, ifMatch?: string) {
    const media = b.mediaId ? await readyMedia(this.db, b.mediaId, ['audio']) : null;
    return this.writer.run(actor, { action: 'soundBlock.update', type: 'soundBlock', id, catalog: true }, async (tx) => {
      const cur = await lockVersioned<Row>(tx, soundBlocks, soundBlocks.id, id, ifMatch, 'Sound block');
      const set = { ...b, ...(media && { durationSec: media.durationSec ?? 0, loudnessLufs: media.loudnessLufs }), version: cur.version + 1 };
      const [row] = await tx.update(soundBlocks).set(set).where(eq(soundBlocks.id, id)).returning();
      return { result: row!, ...changed(cur, { ...cur, ...b }), version: row!.version };
    });
  }

  async reorder(actor: Actor, order: string[]) {
    return this.writer.run(actor, { action: 'soundBlock.reorder', type: 'soundBlock', id: 'order', catalog: true }, async (tx) => {
      const found = await tx.select({ id: soundBlocks.id }).from(soundBlocks).where(inArray(soundBlocks.id, order)).for('update');
      if (found.length !== order.length) throw new AppError('NOT_FOUND', 'Unknown sound block in the list');
      for (const [i, id] of order.entries()) await tx.update(soundBlocks).set({ order: i }).where(eq(soundBlocks.id, id));
      return { result: null, after: { order } };
    }).then(() => this.list());
  }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin/sound-blocks')
export class SoundBlocksController {
  constructor(private readonly blocks: SoundBlocksService) {}

  @Get() list(@Query(new Zod(ListQuery)) q: z.infer<typeof ListQuery>) { return this.blocks.list(q.kind); }

  @HttpCode(201) @Post()
  async create(@CurrentActor() a: Actor, @Body(new Zod(CreateDto)) b: z.infer<typeof CreateDto>, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.blocks.create(a, b); res.header('etag', etag(row.version)); return row;
  }

  @Put('order')
  order(@CurrentActor() a: Actor, @Body(new Zod(OrderDto)) b: z.infer<typeof OrderDto>) { return this.blocks.reorder(a, b.ids); }

  @Patch(':id')
  async patch(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Body(new Zod(PatchDto)) b: z.infer<typeof PatchDto>, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.blocks.patch(a, id, b, ifMatch); res.header('etag', etag(row.version)); return row;
  }
}
