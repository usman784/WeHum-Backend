import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Param, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { Zod } from '../../../common/zod';
import { programDays, programProgress, programs, sessions } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES } from '../../admin-auth/rbac';
import { AdminWriter, changed, CurrentActor, etag, lockVersioned, type Actor } from '../admin-writer';
import { IdParam, slugify, url, uuid as uuidDto } from '../dto';

const CreateDto = z.object({
  title: z.string().trim().min(1).max(120), description: z.string().max(2000).nullable().optional(),
  coverMediaId: uuidDto.nullable().optional(), coverUrl: url.nullable().optional(),
  access: z.enum(['free', 'premium']).default('premium'), unlockRule: z.enum(['next_day_0700', 'immediate']).default('next_day_0700'),
}).strict();
const PatchDto = CreateDto.partial().extend({ status: z.enum(['draft', 'live', 'archived']).optional() }).strict();
const DaysDto = z.object({
  days: z.array(z.object({ day: z.number().int().min(1).max(60), sessionId: uuidDto, title: z.string().trim().max(120).nullable().optional() }).strict()).min(1).max(60),
}).strict().refine((b) => b.days.every((d, i) => d.day === i + 1), { message: 'Days must be numbered 1…n without gaps', path: ['days'] });
type Row = typeof programs.$inferSelect;

@Injectable()
export class ProgramsService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter) {}

  /** Programs with their days and KPIs (people who started / finished). */
  async list() {
    const [rows, days, started, done] = await Promise.all([
      this.db.select().from(programs).orderBy(asc(programs.title), asc(programs.id)),
      this.db.select().from(programDays).orderBy(asc(programDays.programId), asc(programDays.day)),
      this.db.select({ id: programProgress.programId, n: sql<number>`count(*)::int` }).from(programProgress).groupBy(programProgress.programId),
      this.db.select({ id: programProgress.programId, n: sql<number>`count(*)::int` }).from(programProgress).where(isNotNull(programProgress.completedAt)).groupBy(programProgress.programId),
    ]);
    // Each day carries a short view of its meditation, so the CMS can show title, length and status without one request per day.
    const used = [...new Set(days.map((d) => d.sessionId))];
    const meds = used.length ? await this.db.select({ id: sessions.id, title: sessions.title, durationSec: sessions.durationSec, status: sessions.status, type: sessions.type, themeId: sessions.themeId })
      .from(sessions).where(inArray(sessions.id, used)) : [];
    return rows.map((p) => ({
      ...p, days: days.filter((d) => d.programId === p.id).map((d) => ({ day: d.day, sessionId: d.sessionId, title: d.title, session: meds.find((m) => m.id === d.sessionId) ?? null })),
      kpis: { started: started.find((s) => s.id === p.id)?.n ?? 0, completed: done.find((s) => s.id === p.id)?.n ?? 0 },
    }));
  }

  private async one(id: string) { return (await this.list()).find((p) => p.id === id)!; }

  async create(actor: Actor, b: z.infer<typeof CreateDto>) {
    const id = uuid();
    await this.writer.run(actor, { action: 'program.create', type: 'program', id, catalog: true }, async (tx) => {
      const [{ taken }] = await tx.select({ taken: sql<number>`(count(*) filter (where ${programs.slug} = ${slugify(b.title)}))::int` }).from(programs) as [{ taken: number }];
      const [row] = await tx.insert(programs).values({ id, slug: taken ? `${slugify(b.title)}-${id.slice(-4)}` : slugify(b.title), ...b }).returning();
      return { result: row!, after: b, version: 1 };
    });
    return this.one(id);
  }

  async patch(actor: Actor, id: string, b: z.infer<typeof PatchDto>, ifMatch?: string) {
    await this.writer.run(actor, { action: 'program.update', type: 'program', id, catalog: true }, async (tx) => {
      const cur = await lockVersioned<Row>(tx, programs, programs.id, id, ifMatch, 'Program');
      if (b.status === 'live') {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(programDays).where(eq(programDays.programId, id)) as [{ n: number }];
        if (n === 0) throw new AppError('INVALID_STATE', 'Add at least one day before publishing the program');
      }
      const [row] = await tx.update(programs).set({ ...b, version: cur.version + 1, updatedAt: new Date() }).where(eq(programs.id, id)).returning();
      return { result: row!, ...changed(cur, { ...cur, ...b }), version: row!.version };
    });
    return this.one(id);
  }

  /** Replaces the whole day list (days 1…n). */
  async putDays(actor: Actor, id: string, days: z.infer<typeof DaysDto>['days'], ifMatch?: string) {
    await this.writer.run(actor, { action: 'program.days', type: 'program', id, catalog: true }, async (tx) => {
      const cur = await lockVersioned<Row>(tx, programs, programs.id, id, ifMatch, 'Program');
      const wanted = [...new Set(days.map((d) => d.sessionId))];
      const found = await tx.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, wanted));
      if (found.length !== wanted.length) throw new AppError('NOT_FOUND', 'One of the meditations does not exist');
      const before = await tx.select().from(programDays).where(eq(programDays.programId, id)).orderBy(asc(programDays.day));
      await tx.delete(programDays).where(eq(programDays.programId, id));
      await tx.insert(programDays).values(days.map((d) => ({ programId: id, day: d.day, sessionId: d.sessionId, title: d.title ?? null })));
      const [row] = await tx.update(programs).set({ version: cur.version + 1, updatedAt: new Date() }).where(eq(programs.id, id)).returning();
      return { result: row!, before: { days: before.map((d) => d.sessionId) }, after: { days: days.map((d) => d.sessionId) }, version: row!.version };
    });
    return this.one(id);
  }

  async version(id: string) { return (await this.one(id)).version; }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin/programs')
export class ProgramsController {
  constructor(private readonly programs: ProgramsService) {}

  @Get() list() { return this.programs.list(); }

  @HttpCode(201) @Post()
  async create(@CurrentActor() a: Actor, @Body(new Zod(CreateDto)) b: z.infer<typeof CreateDto>, @Res({ passthrough: true }) res: FastifyReply) {
    const p = await this.programs.create(a, b); res.header('etag', etag(p.version)); return p;
  }

  @Patch(':id')
  async patch(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Body(new Zod(PatchDto)) b: z.infer<typeof PatchDto>, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const p = await this.programs.patch(a, id, b, m); res.header('etag', etag(p.version)); return p;
  }

  @Put(':id/days')
  async days(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Body(new Zod(DaysDto)) b: z.infer<typeof DaysDto>, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const p = await this.programs.putDays(a, id, b.days, m); res.header('etag', etag(p.version)); return p;
  }
}
