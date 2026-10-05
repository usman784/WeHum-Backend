import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Injectable, Param, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { Zod } from '../../../common/zod';
import { dailyMessages } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES } from '../../admin-auth/rbac';
import { AdminWriter, assertVersion, CurrentActor, etag, type Actor } from '../admin-writer';
import { isoDate, uuid as uuidDto } from '../dto';
import { readyMedia } from '../media-check';

const PutDto = z.object({
  type: z.enum(['audio', 'video', 'text']), title: z.string().trim().min(1).max(120), text: z.string().max(4000).nullable().optional(),
  mediaId: uuidDto.nullable().optional(), imageMediaId: uuidDto.nullable().optional(), durationSec: z.number().int().min(1).max(3600).nullable().optional(),
  themeTag: z.string().trim().max(40).nullable().optional(), status: z.enum(['draft', 'scheduled', 'live', 'archived']).default('draft'),
}).strict();
const RangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const DateParam = new Zod(isoDate);
const MAX_RANGE_DAYS = 100;

export const monthRange = () => { const n = new Date(); return { from: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString().slice(0, 10), to: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) }; };
export function checkRange(from: string, to: string) {
  if (to < from) throw new AppError('VALIDATION_FAILED', '`to` must not be before `from`');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) throw new AppError('VALIDATION_FAILED', `At most ${MAX_RANGE_DAYS} days at a time`);
}

@Injectable()
export class DailyMessagesAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter) {}

  async list(q: z.infer<typeof RangeQuery>) {
    const r = { ...monthRange(), ...(q.from && { from: q.from }), ...(q.to && { to: q.to }) };
    checkRange(r.from, r.to);
    return this.db.select().from(dailyMessages).where(and(gte(dailyMessages.date, r.from), lte(dailyMessages.date, r.to))).orderBy(asc(dailyMessages.date));
  }

  /** Create or replace the message of a day. Going live needs its content (text, or processed audio/video). */
  async upsert(actor: Actor, date: string, b: z.infer<typeof PutDto>, ifMatch?: string) {
    if (b.status === 'live') {
      if (b.type === 'text' && !b.text?.trim()) throw new AppError('VALIDATION_FAILED', 'A text message needs text', { fields: [{ path: 'text', message: 'Required' }] });
      if (b.type !== 'text') {
        if (!b.mediaId) throw new AppError('VALIDATION_FAILED', 'Add the audio or video first', { fields: [{ path: 'mediaId', message: 'Required' }] });
      }
    }
    if (b.mediaId) await readyMedia(this.db, b.mediaId, ['audio', 'video']);
    if (b.imageMediaId) await readyMedia(this.db, b.imageMediaId, ['image']);
    return this.writer.run(actor, { action: 'dailyMessage.upsert', type: 'dailyMessage', id: date }, async (tx) => {
      const [cur] = await tx.select().from(dailyMessages).where(eq(dailyMessages.date, date)).for('update');
      if (cur) assertVersion(ifMatch, cur);
      const values = { ...b, text: b.text ?? null, mediaId: b.mediaId ?? null, imageMediaId: b.imageMediaId ?? null, durationSec: b.durationSec ?? null, themeTag: b.themeTag ?? null };
      const [row] = cur
        ? await tx.update(dailyMessages).set({ ...values, version: cur.version + 1, updatedAt: new Date() }).where(eq(dailyMessages.date, date)).returning()
        : await tx.insert(dailyMessages).values({ date, ...values }).returning();
      return { result: row!, before: cur ?? null, after: values, version: row!.version };
    });
  }

  async remove(actor: Actor, date: string) {
    await this.writer.run(actor, { action: 'dailyMessage.delete', type: 'dailyMessage', id: date }, async (tx) => {
      const [cur] = await tx.delete(dailyMessages).where(eq(dailyMessages.date, date)).returning();
      if (!cur) throw new AppError('NOT_FOUND', 'No message for this day');
      return { result: null, before: cur };
    });
  }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin/daily-messages')
export class DailyMessagesAdminController {
  constructor(private readonly messages: DailyMessagesAdminService) {}

  @Get() list(@Query(new Zod(RangeQuery)) q: z.infer<typeof RangeQuery>) { return this.messages.list(q); }

  @Put(':date')
  async put(@CurrentActor() a: Actor, @Param('date', DateParam) date: string, @Body(new Zod(PutDto)) b: z.infer<typeof PutDto>, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.messages.upsert(a, date, b, m); res.header('etag', etag(row.version)); return row;
  }

  @HttpCode(204) @Delete(':date')
  async remove(@CurrentActor() a: Actor, @Param('date', DateParam) date: string) { await this.messages.remove(a, date); }
}
