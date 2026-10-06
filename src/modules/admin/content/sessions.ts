import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Injectable, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, eq, gte, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { clampLimit, decodeCursor, encodeCursor } from '../../../common/pagination';
import { Zod } from '../../../common/zod';
import { dedications, motdDays, programDays, programs, sessions } from '../../../db/schema';
import { CdnSigner } from '../../../infra/cdn';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES, MANAGER_ROLES } from '../../admin-auth/rbac';
import { coverMap, toCover } from '../../catalog/catalog.mapper';
import { utcToday } from '../../motd/motd.service';
import { AdminWriter, changed, CurrentActor, etag, lockVersioned, type Actor, type Tx } from '../admin-writer';
import { cursorQuery, IdParam, ids, slugify, url, uuid as uuidDto } from '../dto';
import { readyMedia } from '../media-check';

type Row = typeof sessions.$inferSelect;
const tag = z.string().trim().toLowerCase().min(1).max(30);
const Fields = z.object({
  title: z.string().trim().min(1).max(120), description: z.string().max(4000).nullable(),
  type: z.enum(['audio', 'video', 'youtube']), access: z.enum(['free', 'premium']),
  themeId: uuidDto.nullable(), teacherId: uuidDto.nullable(), tags: z.array(tag).max(12),
  durationSec: z.number().int().min(1).max(4 * 3600), mediaId: uuidDto.nullable(), youtubeId: z.string().regex(/^[\w-]{11}$/, '11-character YouTube id').nullable(),
  coverMediaId: uuidDto.nullable(), coverUrl: url.nullable(), downloadable: z.boolean(),
  sosFeeling: z.string().trim().max(40).nullable(), sosSubtitle: z.string().trim().max(80).nullable(),
});
const CreateDto = Fields.partial().required({ title: true, type: true }).strict()
  .refine((b) => b.type !== 'youtube' || (b.access ?? 'free') === 'free', { message: 'YouTube items are always free', path: ['access'] });
const PatchDto = Fields.partial().strict();
const ScheduleDto = z.object({ publishAt: z.string().datetime() }).strict();
const BulkDto = z.object({ action: z.enum(['publish', 'archive', 'changeTheme']), ids, themeId: uuidDto.optional() }).strict()
  .refine((b) => b.action !== 'changeTheme' || !!b.themeId, { message: 'themeId is required', path: ['themeId'] });
const ListQuery = z.object({
  tab: z.enum(['all', 'published', 'drafts', 'scheduled', 'archived']).default('all'),
  status: z.enum(['draft', 'scheduled', 'live', 'archived']).optional(),
  q: z.string().trim().min(1).max(60).optional(), theme: uuidDto.optional(), teacher: uuidDto.optional(),
  type: z.enum(['audio', 'video', 'youtube']).optional(), access: z.enum(['free', 'premium']).optional(),
  sos: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), // CMS "SoS" tab
  sort: z.enum(['updated', 'title', 'plays', 'published']).default('updated'), ...cursorQuery,
});
const TAB_STATUS = { published: 'live', drafts: 'draft', scheduled: 'scheduled', archived: 'archived' } as const;

/** Sort keys for keyset paging: the cursor carries the key as Postgres text, so ties and microseconds are exact. */
const SORTS = {
  updated: { expr: sql`${sessions.updatedAt}`, dir: 'desc', cast: 'timestamptz' },
  title: { expr: sql`${sessions.title}`, dir: 'asc', cast: 'text' },
  plays: { expr: sql`${sessions.plays}`, dir: 'desc', cast: 'int' },
  published: { expr: sql`coalesce(${sessions.publishAt}, ${sessions.createdAt})`, dir: 'desc', cast: 'timestamptz' },
} as const;

@Injectable()
export class SessionsAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter, private readonly cdn: CdnSigner) {}

  private async view(rows: Row[]) {
    const covers = await coverMap(this.db, rows.map((s) => s.coverMediaId));
    return rows.map((s) => ({ ...s, cover: toCover(this.cdn, covers, s.coverMediaId, s.coverUrl) }));
  }

  async list(q: z.infer<typeof ListQuery>) {
    const limit = clampLimit(q.limit, 30);
    const sort = SORTS[q.sort];
    const status = q.status ?? (q.tab === 'all' ? undefined : TAB_STATUS[q.tab]);
    const conds: (SQL | undefined)[] = [
      status ? eq(sessions.status, status) : undefined, q.theme ? eq(sessions.themeId, q.theme) : undefined, q.teacher ? eq(sessions.teacherId, q.teacher) : undefined,
      q.type ? eq(sessions.type, q.type) : undefined, q.access ? eq(sessions.access, q.access) : undefined,
      q.sos === undefined ? undefined : eq(sessions.isSos, q.sos),
      q.q ? or(ilike(sessions.title, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), sql`${sessions.tags} @> ARRAY[${q.q.toLowerCase()}]::text[]`) : undefined,
    ];
    // How many match the filters in all (the CMS shows "Showing 30 of 142"); counted before the cursor narrows the page.
    const [{ total }] = await this.db.select({ total: sql<number>`count(*)::int` }).from(sessions).where(and(...conds)) as [{ total: number }];
    const c = decodeCursor(q.cursor);
    if (c) conds.push(sort.dir === 'desc' ? sql`(${sort.expr}, ${sessions.id}) < (${String(c.k)}::${sql.raw(sort.cast)}, ${c.id}::uuid)` : sql`(${sort.expr}, ${sessions.id}) > (${String(c.k)}::${sql.raw(sort.cast)}, ${c.id}::uuid)`);
    const dir = sort.dir === 'desc' ? sql`desc` : sql`asc`;
    const rows = await this.db.select({ s: sessions, k: sql<string>`${sort.expr}::text` }).from(sessions).where(and(...conds)).orderBy(sql`${sort.expr} ${dir}`, sql`${sessions.id} ${dir}`).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { data: await this.view(page.map((r) => r.s)), meta: { nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.k, page.at(-1)!.s.id) : null, total } };
  }

  async get(id: string) {
    const [s] = await this.db.select().from(sessions).where(eq(sessions.id, id));
    if (!s) throw new AppError('NOT_FOUND', 'Meditation not found');
    const [[view], motd, progs, dedCount] = await Promise.all([
      this.view([s]),
      this.db.select({ date: motdDays.date }).from(motdDays).where(eq(motdDays.sessionId, id)).orderBy(motdDays.date),
      this.db.select({ id: programs.id, title: programs.title, day: programDays.day }).from(programDays).innerJoin(programs, eq(programs.id, programDays.programId)).where(eq(programDays.sessionId, id)),
      this.db.select({ n: sql<number>`count(*)::int` }).from(dedications).where(eq(dedications.sessionId, id)),
    ]);
    return { ...view!, usage: { motdDates: motd.map((m) => m.date), programs: progs, dedications: dedCount[0]?.n ?? 0 } };
  }

  private async slugFor(tx: Tx | DB, title: string, id: string) {
    const base = slugify(title);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(sessions).where(eq(sessions.slug, base)) as [{ n: number }];
    return n ? `${base}-${id.slice(-6)}` : base;
  }

  /** Duration comes from the processed file when there is one. */
  private async duration(media: { durationSec: number | null } | null, given?: number) { return media?.durationSec ?? given ?? 0; }

  async create(actor: Actor, b: z.infer<typeof CreateDto>) {
    const id = uuid();
    const media = b.mediaId ? await readyMedia(this.db, b.mediaId, [b.type === 'video' ? 'video' : 'audio']).catch((e) => { if (e instanceof AppError && e.code === 'MEDIA_NOT_READY') return null; throw e; }) : null;
    return this.writer.run(actor, { action: 'session.create', type: 'session', id }, async (tx) => {
      const [row] = await tx.insert(sessions).values({
        ...b, id, slug: await this.slugFor(tx, b.title, id), access: b.type === 'youtube' ? 'free' : b.access ?? 'premium',
        durationSec: await this.duration(media, b.durationSec), status: 'draft',
      }).returning();
      return { result: row!, after: b, version: 1 };
    });
  }

  private async lockOne(tx: Tx, id: string, ifMatch?: string) { return lockVersioned<Row>(tx, sessions, sessions.id, id, ifMatch, 'Meditation'); }

  async patch(actor: Actor, id: string, b: z.infer<typeof PatchDto>, ifMatch?: string) {
    const [pre] = await this.db.select({ status: sessions.status, type: sessions.type }).from(sessions).where(eq(sessions.id, id));
    if (!pre) throw new AppError('NOT_FOUND', 'Meditation not found');
    const type = b.type ?? pre.type;
    if (type === 'youtube' && b.access === 'premium') throw new AppError('VALIDATION_FAILED', 'YouTube items are always free', { fields: [{ path: 'access', message: 'Must be free' }] });
    const media = b.mediaId ? await readyMedia(this.db, b.mediaId, [type === 'video' ? 'video' : 'audio']).catch((e) => { if (e instanceof AppError && e.code === 'MEDIA_NOT_READY') return null; throw e; }) : null;
    return this.writer.run(actor, { action: 'session.update', type: 'session', id, catalog: pre.status === 'live', invalidate: [] }, async (tx) => {
      const cur = await this.lockOne(tx, id, ifMatch);
      const next = { ...b, ...(type === 'youtube' && { access: 'free' as const }), ...(media && { durationSec: media.durationSec ?? b.durationSec ?? cur.durationSec }) };
      const [row] = await tx.update(sessions).set({ ...next, version: cur.version + 1, updatedAt: new Date(), updatedBy: actor.id }).where(eq(sessions.id, id)).returning();
      return { result: row!, ...changed(cur, { ...cur, ...next }), version: row!.version };
    });
  }

  /** A meditation goes live only with something to play: processed media, or a YouTube id. */
  private async assertPlayable(tx: Tx, s: Row) {
    if (s.type === 'youtube') {
      if (!s.youtubeId) throw new AppError('VALIDATION_FAILED', 'Add the YouTube link first', { fields: [{ path: 'youtubeId', message: 'Required' }] });
      return s.durationSec;
    }
    if (!s.mediaId) throw new AppError('MEDIA_NOT_READY', 'Upload the audio or video first');
    const m = await readyMedia(tx, s.mediaId, [s.type === 'video' ? 'video' : 'audio']);
    return m.durationSec ?? s.durationSec;
  }

  async publish(actor: Actor, id: string, ifMatch?: string) {
    return this.writer.run(actor, { action: 'session.publish', type: 'session', id, catalog: true }, async (tx) => {
      const cur = await this.lockOne(tx, id, ifMatch);
      if (cur.status === 'live') throw new AppError('INVALID_STATE', 'Already published');
      const durationSec = await this.assertPlayable(tx, cur);
      const [row] = await tx.update(sessions).set({ status: 'live', publishAt: new Date(), durationSec, version: cur.version + 1, updatedAt: new Date(), updatedBy: actor.id }).where(eq(sessions.id, id)).returning();
      return { result: row!, before: { status: cur.status }, after: { status: 'live' }, version: row!.version };
    });
  }

  async schedule(actor: Actor, id: string, publishAt: string, ifMatch?: string) {
    const at = new Date(publishAt);
    if (at.getTime() < Date.now() + 60_000) throw new AppError('VALIDATION_FAILED', 'Pick a time in the future', { fields: [{ path: 'publishAt', message: 'Must be at least a minute from now' }] });
    return this.writer.run(actor, { action: 'session.schedule', type: 'session', id }, async (tx) => {
      const cur = await this.lockOne(tx, id, ifMatch);
      if (cur.status === 'live') throw new AppError('INVALID_STATE', 'Already published. Archive it instead.');
      await this.assertPlayable(tx, cur);
      const [row] = await tx.update(sessions).set({ status: 'scheduled', publishAt: at, version: cur.version + 1, updatedAt: new Date(), updatedBy: actor.id }).where(eq(sessions.id, id)).returning();
      return { result: row!, before: { status: cur.status }, after: { status: 'scheduled', publishAt }, version: row!.version };
    });
  }

  async archive(actor: Actor, id: string, ifMatch?: string) {
    return this.writer.run(actor, { action: 'session.archive', type: 'session', id, catalog: true }, async (tx) => {
      const cur = await this.lockOne(tx, id, ifMatch);
      if (cur.status === 'archived') throw new AppError('INVALID_STATE', 'Already archived');
      const future = await tx.select({ date: motdDays.date }).from(motdDays).where(and(eq(motdDays.sessionId, id), gte(motdDays.date, utcToday()))).orderBy(motdDays.date);
      if (future.length) throw new AppError('IN_USE', 'This meditation is the meditation of the day on a coming date. Change that first.', { motdDates: future.map((f) => f.date) });
      const [row] = await tx.update(sessions).set({ status: 'archived', isSos: false, sosOrder: null, version: cur.version + 1, updatedAt: new Date(), updatedBy: actor.id }).where(eq(sessions.id, id)).returning();
      return { result: row!, before: { status: cur.status }, after: { status: 'archived' }, version: row!.version };
    });
  }

  async duplicate(actor: Actor, id: string) {
    const nid = uuid();
    return this.writer.run(actor, { action: 'session.duplicate', type: 'session', id: nid }, async (tx) => {
      const [src] = await tx.select().from(sessions).where(eq(sessions.id, id));
      if (!src) throw new AppError('NOT_FOUND', 'Meditation not found');
      const title = `${src.title} (copy)`.slice(0, 120);
      const [row] = await tx.insert(sessions).values({
        ...src, id: nid, title, slug: await this.slugFor(tx, title, nid), status: 'draft', publishAt: null, plays: 0, completions: 0, isSos: false, sosOrder: null,
        version: 1, createdAt: new Date(), updatedAt: new Date(), updatedBy: actor.id,
      }).returning();
      return { result: row!, after: { copiedFrom: id }, version: 1 };
    });
  }

  async remove(actor: Actor, id: string) {
    await this.writer.run(actor, { action: 'session.delete', type: 'session', id }, async (tx) => {
      const cur = await this.lockOne(tx, id);
      if (cur.status !== 'draft') throw new AppError('INVALID_STATE', 'Only drafts can be deleted. Archive published meditations instead.');
      try { await tx.delete(sessions).where(eq(sessions.id, id)); }
      catch (e) { if ((e as { code?: string }).code === '23503' || (e as { cause?: { code?: string } }).cause?.code === '23503') throw new AppError('IN_USE', 'This meditation is used in a program or on the Today screen'); throw e; }
      return { result: null, before: { title: cur.title } };
    });
  }

  /** One result per item; a failing item does not stop the others. */
  async bulk(actor: Actor, b: z.infer<typeof BulkDto>) {
    const results: { id: string; ok: boolean; error?: { code: string; message: string } }[] = [];
    for (const id of b.ids) {
      try {
        if (b.action === 'publish') await this.publish(actor, id);
        else if (b.action === 'archive') await this.archive(actor, id);
        else await this.patch(actor, id, { themeId: b.themeId! });
        results.push({ id, ok: true });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ id, ok: false, error: { code: e.code, message: e.message } });
      }
    }
    return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@Controller('v1/admin/sessions')
export class SessionsAdminController {
  constructor(private readonly sessions: SessionsAdminService) {}

  private static tag(res: FastifyReply, row: { version: number }) { res.header('etag', etag(row.version)); return row; }

  @AdminRoles(...CONTENT_ROLES) @Get()
  list(@Query(new Zod(ListQuery)) q: z.infer<typeof ListQuery>) { return this.sessions.list(q); }

  @AdminRoles(...CONTENT_ROLES) @HttpCode(201) @Post()
  async create(@CurrentActor() a: Actor, @Body(new Zod(CreateDto)) b: z.infer<typeof CreateDto>, @Res({ passthrough: true }) res: FastifyReply) { return SessionsAdminController.tag(res, await this.sessions.create(a, b)); }

  // static paths first: `bulk` must not be read as an id
  @AdminRoles(...CONTENT_ROLES) @HttpCode(200) @Post('bulk')
  bulk(@CurrentActor() a: Actor, @Body(new Zod(BulkDto)) b: z.infer<typeof BulkDto>) { return this.sessions.bulk(a, b); }

  @AdminRoles(...CONTENT_ROLES) @Get(':id')
  async get(@Param('id', new Zod(IdParam)) id: string, @Res({ passthrough: true }) res: FastifyReply) { return SessionsAdminController.tag(res, await this.sessions.get(id)); }

  @AdminRoles(...CONTENT_ROLES) @Patch(':id')
  async patch(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Body(new Zod(PatchDto)) b: z.infer<typeof PatchDto>, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    return SessionsAdminController.tag(res, await this.sessions.patch(a, id, b, m));
  }

  @AdminRoles(...CONTENT_ROLES) @HttpCode(200) @Post(':id/publish')
  async publish(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) { return SessionsAdminController.tag(res, await this.sessions.publish(a, id, m)); }

  @AdminRoles(...CONTENT_ROLES) @HttpCode(200) @Post(':id/schedule')
  async schedule(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Body(new Zod(ScheduleDto)) b: z.infer<typeof ScheduleDto>, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    return SessionsAdminController.tag(res, await this.sessions.schedule(a, id, b.publishAt, m));
  }

  @AdminRoles(...CONTENT_ROLES) @HttpCode(200) @Post(':id/archive')
  async archive(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) { return SessionsAdminController.tag(res, await this.sessions.archive(a, id, m)); }

  @AdminRoles(...CONTENT_ROLES) @HttpCode(201) @Post(':id/duplicate')
  async duplicate(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Res({ passthrough: true }) res: FastifyReply) { return SessionsAdminController.tag(res, await this.sessions.duplicate(a, id)); }

  @AdminRoles(...MANAGER_ROLES) @HttpCode(204) @Delete(':id')
  async remove(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string) { await this.sessions.remove(a, id); }
}
