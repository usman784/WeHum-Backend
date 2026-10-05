import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, asc, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { Zod } from '../../../common/zod';
import { mediaAssets, motdDays, motdVariants, sessions } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES } from '../../admin-auth/rbac';
import { addDaysIso, utcToday } from '../../motd/motd.service';
import { ConfigAdminService } from './config';
import { AdminWriter, assertVersion, CurrentActor, etag, type Actor } from '../admin-writer';
import { hhmm, isoDate, LENGTHS, uuid as uuidDto } from '../dto';
import { readyMedia } from '../media-check';
import { checkRange } from './daily-messages';

const RangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const PutDto = z.object({ sessionId: uuidDto, groupStartUtc: hhmm.nullable().optional(), groupLengthMin: z.union([z.literal(10), z.literal(30), z.literal(45)]).nullable().optional() }).strict();
const VariantDto = z.object({ mediaId: uuidDto }).strict();
const SwapDto = z.object({ a: isoDate, b: isoDate }).strict().refine((v) => v.a !== v.b, 'Pick two different days');
const DateParam = new Zod(isoDate);
const LenParam = new Zod(z.coerce.number().refine((n): n is 10 | 30 | 45 => (LENGTHS as readonly number[]).includes(n), 'Length must be 10, 30 or 45'));

/** Past days are history (stats and the dedication archive hang off them), so they cannot be edited any more. */
const assertNotPast = (date: string) => { if (date < utcToday()) throw new AppError('INVALID_STATE', 'Past days can no longer be changed'); };

@Injectable()
export class MotdAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter, private readonly config: ConfigAdminService) {}

  async range(q: z.infer<typeof RangeQuery>) {
    const from = q.from ?? utcToday(), to = q.to ?? addDaysIso(from, 14);
    checkRange(from, to);
    const [days, variants] = await Promise.all([
      this.db.select({ d: motdDays, title: sessions.title, status: sessions.status }).from(motdDays).innerJoin(sessions, eq(sessions.id, motdDays.sessionId)).where(and(gte(motdDays.date, from), lte(motdDays.date, to))),
      this.db.select({ v: motdVariants, status: mediaAssets.status, duration: mediaAssets.durationSec }).from(motdVariants).innerJoin(mediaAssets, eq(mediaAssets.id, motdVariants.mediaId)).where(and(gte(motdVariants.date, from), lte(motdVariants.date, to))),
    ]);
    const out = [];
    for (let d = from; d <= to; d = addDaysIso(d, 1)) {
      const day = days.find((x) => x.d.date === d);
      const vs = variants.filter((x) => x.v.date === d);
      const byLen = Object.fromEntries(LENGTHS.map((len) => { const v = vs.find((x) => x.v.lengthMin === len); return [len, v ? { mediaId: v.v.mediaId, status: v.status, durationSec: v.duration } : null]; }));
      out.push(day ? {
        date: d, sessionId: day.d.sessionId, sessionTitle: day.title, sessionStatus: day.status, groupStartUtc: day.d.groupStartUtc, groupLengthMin: day.d.groupLengthMin,
        variants: byLen, complete: LENGTHS.every((l) => vs.find((x) => x.v.lengthMin === l)?.status === 'ready'), practicedToday: day.d.practicedToday, version: day.d.version,
      } : { date: d, sessionId: null, variants: null, complete: false });
    }
    return out;
  }

  async set(actor: Actor, date: string, b: z.infer<typeof PutDto>, ifMatch?: string) {
    assertNotPast(date);
    const [s] = await this.db.select({ status: sessions.status, isSos: sessions.isSos, type: sessions.type }).from(sessions).where(eq(sessions.id, b.sessionId));
    if (!s) throw new AppError('NOT_FOUND', 'Meditation not found');
    if (s.status !== 'live' || s.isSos || s.type === 'youtube') throw new AppError('INVALID_STATE', 'The meditation of the day must be a published, premium meditation');
    return this.writer.run(actor, { action: 'motd.set', type: 'motd', id: date, invalidate: [`motd:${date}`] }, async (tx) => {
      const [cur] = await tx.select().from(motdDays).where(eq(motdDays.date, date)).for('update');
      if (cur) assertVersion(ifMatch, cur);
      const values = { sessionId: b.sessionId, groupStartUtc: b.groupStartUtc ?? null, groupLengthMin: b.groupLengthMin ?? null };
      const [row] = cur
        ? await tx.update(motdDays).set({ ...values, version: cur.version + 1, updatedAt: new Date() }).where(eq(motdDays.date, date)).returning()
        : await tx.insert(motdDays).values({ date, ...values }).returning();
      return { result: row!, before: cur ? { sessionId: cur.sessionId } : null, after: values, version: row!.version };
    });
  }

  async setVariant(actor: Actor, date: string, len: 10 | 30 | 45, mediaId: string) {
    assertNotPast(date);
    await readyMedia(this.db, mediaId, ['audio']);
    return this.writer.run(actor, { action: 'motd.variant', type: 'motd', id: date, invalidate: [`motd:${date}`] }, async (tx) => {
      const [day] = await tx.select().from(motdDays).where(eq(motdDays.date, date)).for('update');
      if (!day) throw new AppError('INVALID_STATE', 'Pick the meditation for this day first');
      const [prev] = await tx.select().from(motdVariants).where(and(eq(motdVariants.date, date), eq(motdVariants.lengthMin, len)));
      await tx.insert(motdVariants).values({ date, lengthMin: len, mediaId }).onConflictDoUpdate({ target: [motdVariants.date, motdVariants.lengthMin], set: { mediaId } });
      const [row] = await tx.update(motdDays).set({ version: day.version + 1, updatedAt: new Date() }).where(eq(motdDays.date, date)).returning();
      return { result: row!, before: { [len]: prev?.mediaId ?? null }, after: { [len]: mediaId }, version: row!.version };
    });
  }

  /** Swaps everything between two days (session, group override, the three variants). */
  async swap(actor: Actor, a: string, b: string) {
    assertNotPast(a); assertNotPast(b);
    await this.writer.run(actor, { action: 'motd.swap', type: 'motd', id: `${a}↔${b}`, invalidate: [`motd:${a}`, `motd:${b}`] }, async (tx) => {
      const days = await tx.select().from(motdDays).where(inArray(motdDays.date, [a, b])).for('update');
      const da = days.find((d) => d.date === a), db = days.find((d) => d.date === b);
      if (!da || !db) throw new AppError('NOT_FOUND', 'Both days need a meditation to be swapped');
      const vars = await tx.select().from(motdVariants).where(inArray(motdVariants.date, [a, b]));
      await tx.delete(motdVariants).where(inArray(motdVariants.date, [a, b]));
      const carry = (d: typeof da) => ({ sessionId: d.sessionId, groupStartUtc: d.groupStartUtc, groupLengthMin: d.groupLengthMin });
      await tx.update(motdDays).set({ ...carry(db), version: da.version + 1, updatedAt: new Date() }).where(eq(motdDays.date, a));
      await tx.update(motdDays).set({ ...carry(da), version: db.version + 1, updatedAt: new Date() }).where(eq(motdDays.date, b));
      const moved = vars.map((v) => ({ date: v.date === a ? b : a, lengthMin: v.lengthMin, mediaId: v.mediaId }));
      if (moved.length) await tx.insert(motdVariants).values(moved);
      return { result: null, before: { [a]: da.sessionId, [b]: db.sessionId }, after: { [a]: db.sessionId, [b]: da.sessionId } };
    });
    return [...await this.range({ from: a, to: a }), ...await this.range({ from: b, to: b })];
  }

  /** Group meditation settings + the last 14 days of group stats. */
  async group() {
    const [cfg, hist] = await Promise.all([
      this.config.get('group'),
      this.db.select({ date: motdDays.date, title: sessions.title, joined: motdDays.groupJoined, solo: motdDays.soloCount, practiced: motdDays.practicedToday })
        .from(motdDays).innerJoin(sessions, eq(sessions.id, motdDays.sessionId)).where(lt(motdDays.date, utcToday())).orderBy(desc(motdDays.date)).limit(14),
    ]);
    return { ...cfg, history: hist.map((h) => ({ date: h.date, title: h.title, groupJoined: h.joined, soloCount: h.solo, practicedToday: h.practiced })) };
  }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin')
export class MotdAdminController {
  constructor(private readonly motd: MotdAdminService) {}

  @Get('motd') range(@Query(new Zod(RangeQuery)) q: z.infer<typeof RangeQuery>) { return this.motd.range(q); }

  @Post('motd/swap') @HttpCode(200)
  swap(@CurrentActor() a: Actor, @Body(new Zod(SwapDto)) b: z.infer<typeof SwapDto>) { return this.motd.swap(a, b.a, b.b); }

  @Put('motd/:date')
  async set(@CurrentActor() a: Actor, @Param('date', DateParam) date: string, @Body(new Zod(PutDto)) b: z.infer<typeof PutDto>, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.motd.set(a, date, b, m); res.header('etag', etag(row.version)); return row;
  }

  @Put('motd/:date/variants/:len')
  async variant(@CurrentActor() a: Actor, @Param('date', DateParam) date: string, @Param('len', LenParam) len: 10 | 30 | 45, @Body(new Zod(VariantDto)) b: z.infer<typeof VariantDto>, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.motd.setVariant(a, date, len, b.mediaId); res.header('etag', etag(row.version)); return row;
  }

  @Get('group')
  async group(@Res({ passthrough: true }) res: FastifyReply) { const g = await this.motd.group(); res.header('etag', etag(g.version)); return g; }
}
