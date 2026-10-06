import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Injectable, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AdminRoles } from '../../common/auth';
import { AppError } from '../../common/errors';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import { Zod } from '../../common/zod';
import { breathPatterns, gratitudePosts, gratitudeReports, userMilestones, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { RealtimeBus } from '../../infra/realtime-bus';
import { CONTENT_ROLES, MANAGER_ROLES, MODERATION_ROLES } from '../admin-auth/rbac';
import { AdminWriter, assertVersion, CurrentActor, etag, type Actor } from '../admin/admin-writer';
import { ids } from '../admin/dto';
import { GRATITUDE_REVIEW, postView } from './coming-soon.service';
import { MILESTONES, patternProblem } from './rules';

const Queue = z.object({
  filter: z.enum(['review', 'flagged', 'hidden', 'all']).default('review'), kind: z.enum(['gratitude', 'affirmation', 'love']).optional(),
  cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
});
const Bulk = z.object({ ids, action: z.enum(['hide', 'keep']) }).strict();
const Beat = z.number().int().min(0).max(20);
const PatternFields = {
  name: z.string().trim().min(1).max(40), subtitle: z.string().trim().max(80).default(''), inhaleSec: Beat, hold1Sec: Beat.default(0), exhaleSec: Beat, hold2Sec: Beat.default(0),
  rounds: z.number().int().min(1).max(100).default(10), sort: z.number().int().min(0).max(1000).default(0),
};
const PatternCreate = z.object(PatternFields).strict();
const PatternPatch = z.object({ ...PatternFields, status: z.enum(['draft', 'live', 'archived']) }).partial().strict();
const Id = new Zod(z.string().uuid());

@Injectable()
export class ComingSoonAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter, private readonly bus: RealtimeBus) {}

  // ───────────── gratitude moderation (CMS screen 14, "Gratitude feed" tab)
  async queue(q: z.infer<typeof Queue>) {
    const limit = clampLimit(q.limit, 30);
    const conds: SQL[] = [];
    if (q.filter === 'review') conds.push(GRATITUDE_REVIEW);
    if (q.filter === 'flagged') conds.push(sql`${gratitudePosts.status} = 'flagged'`);
    if (q.filter === 'hidden') conds.push(sql`${gratitudePosts.status} = 'hidden'`);
    if (q.kind) conds.push(eq(gratitudePosts.kind, q.kind));
    const prio = sql`(${gratitudePosts.autoFlags} @> array['crisis']::text[])::int`;
    const c = decodeCursor(q.cursor);
    if (c) {
      const [p, at] = String(c.k).split('|') as [string, string];
      conds.push(sql`(${prio}, ${gratitudePosts.createdAt}, ${gratitudePosts.id}) < (${Number(p)}, ${new Date(at)}, ${c.id}::uuid)`);
    }
    const rows = await this.db.select({
      p: gratitudePosts, muted: users.mutedAt, priority: prio.mapWith(Number),
      reasons: sql<string[]>`coalesce((select array_agg(distinct r.reason) from ${gratitudeReports} r where r.post_id = ${gratitudePosts.id}), '{}')`,
    }).from(gratitudePosts).innerJoin(users, eq(users.id, gratitudePosts.userId)).where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(prio), desc(gratitudePosts.createdAt), desc(gratitudePosts.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const [open] = await this.db.select({ n: sql<number>`count(*)::int` }).from(gratitudePosts).where(GRATITUDE_REVIEW);
    return {
      data: page.map((r) => ({
        ...postView(r.p), userId: r.p.userId, status: r.p.status, autoFlags: r.p.autoFlags, reportCount: r.p.reportCount, reasons: r.reasons,
        crisis: r.priority === 1, userMuted: !!r.muted, moderatedAt: r.p.moderatedAt?.toISOString() ?? null,
      })),
      meta: { nextCursor: rows.length > limit && last ? encodeCursor(`${last.priority}|${last.p.createdAt.toISOString()}`, last.p.id) : null, open: open?.n ?? 0 },
    };
  }

  async decide(a: Actor, id: string, action: 'hide' | 'keep') {
    return this.writer.run(a, { action: `gratitude.${action}`, type: 'gratitude', id }, async (tx) => {
      const [cur] = await tx.select().from(gratitudePosts).where(eq(gratitudePosts.id, id)).for('update');
      if (!cur) throw new AppError('NOT_FOUND', 'Post not found');
      const next = action === 'hide' ? 'hidden' : 'visible';
      const [row] = await tx.update(gratitudePosts).set({ status: next, moderatedBy: a.id, moderatedAt: new Date(), ...(action === 'keep' && { autoFlags: [] }) }).where(eq(gratitudePosts.id, id)).returning();
      const events = cur.status === 'visible' && next === 'hidden' ? [{ topic: 'gratitude:removed', payload: { kind: cur.kind, id } }]
        : cur.status !== 'visible' && next === 'visible' ? [{ topic: 'gratitude:new', payload: { kind: cur.kind, item: postView(row!) } }] : [];
      return { result: { id, status: next }, before: { status: cur.status }, after: { status: next }, events };
    });
  }

  /** The 12 milestones and how many people reached each (CMS P9, read-only: milestones are automatic). */
  async milestones() {
    const counts = await this.db.select({ key: userMilestones.key, n: sql<number>`count(*)::int` }).from(userMilestones).groupBy(userMilestones.key);
    const by = new Map(counts.map((c) => [c.key, c.n]));
    return MILESTONES.map((m) => ({ key: m.key, label: m.label, badge: m.badge, metric: m.metric, target: m.target, reached: by.get(m.key) ?? 0 }));
  }

  // ───────────── breath pattern templates (CMS P9)
  patterns() { return this.db.select().from(breathPatterns).orderBy(asc(breathPatterns.sort), asc(breathPatterns.name)); }

  createPattern(a: Actor, b: z.infer<typeof PatternCreate>) {
    const problem = patternProblem(b);
    if (problem) throw new AppError('VALIDATION_FAILED', problem, { fields: [{ path: 'inhaleSec', message: problem }] });
    const id = uuidv7();
    return this.writer.run(a, { action: 'breathPattern.create', type: 'breathPattern', id }, async (tx) => {
      const [row] = await tx.insert(breathPatterns).values({ id, ...b }).returning();
      return { result: row!, after: b, version: 1 };
    });
  }

  updatePattern(a: Actor, id: string, b: z.infer<typeof PatternPatch>, ifMatch?: string) {
    return this.writer.run(a, { action: 'breathPattern.update', type: 'breathPattern', id }, async (tx) => {
      const [cur] = await tx.select().from(breathPatterns).where(eq(breathPatterns.id, id)).for('update');
      if (!cur) throw new AppError('NOT_FOUND', 'Pattern not found');
      assertVersion(ifMatch, cur);
      const problem = patternProblem({ ...cur, ...b });
      if (problem) throw new AppError('VALIDATION_FAILED', problem, { fields: [{ path: 'inhaleSec', message: problem }] });
      const [row] = await tx.update(breathPatterns).set({ ...b, version: cur.version + 1, updatedAt: new Date() }).where(eq(breathPatterns.id, id)).returning();
      return { result: row!, before: cur, after: b, version: row!.version };
    });
  }

  removePattern(a: Actor, id: string) {
    return this.writer.run(a, { action: 'breathPattern.delete', type: 'breathPattern', id }, async (tx) => {
      const [cur] = await tx.delete(breathPatterns).where(eq(breathPatterns.id, id)).returning();
      if (!cur) throw new AppError('NOT_FOUND', 'Pattern not found');
      return { result: null, before: cur };
    });
  }
}

@ApiTags('Admin Coming soon')
@ApiBearerAuth()
@Controller('v1/admin')
export class ComingSoonAdminController {
  constructor(private readonly svc: ComingSoonAdminService) {}

  @AdminRoles(...MODERATION_ROLES) @Get('gratitude') queue(@Query(new Zod(Queue)) q: z.infer<typeof Queue>) { return this.svc.queue(q); }
  @AdminRoles(...MODERATION_ROLES) @HttpCode(200) @Post('gratitude/:id/hide') hide(@CurrentActor() a: Actor, @Param('id', Id) id: string) { return this.svc.decide(a, id, 'hide'); }
  @AdminRoles(...MODERATION_ROLES) @HttpCode(200) @Post('gratitude/:id/keep') keep(@CurrentActor() a: Actor, @Param('id', Id) id: string) { return this.svc.decide(a, id, 'keep'); }
  @AdminRoles(...MODERATION_ROLES) @HttpCode(200) @Post('gratitude/bulk')
  async bulk(@CurrentActor() a: Actor, @Body(new Zod(Bulk)) b: z.infer<typeof Bulk>) {
    const results: { id: string; ok: boolean; status?: string; error?: string }[] = [];
    for (const id of b.ids) {
      try { results.push({ id, ok: true, status: (await this.svc.decide(a, id, b.action)).status }); } catch (e) { results.push({ id, ok: false, error: (e as Error).message }); }
    }
    return { results };
  }

  @AdminRoles(...CONTENT_ROLES) @Get('milestones') milestones() { return this.svc.milestones(); }

  @AdminRoles(...CONTENT_ROLES) @Get('breath-patterns') list() { return this.svc.patterns(); }

  @AdminRoles(...CONTENT_ROLES) @Post('breath-patterns')
  async create(@CurrentActor() a: Actor, @Body(new Zod(PatternCreate)) b: z.infer<typeof PatternCreate>, @Res({ passthrough: true }) res: FastifyReply) {
    const r = await this.svc.createPattern(a, b); res.header('etag', etag(r.version)); return r;
  }

  @AdminRoles(...CONTENT_ROLES) @Patch('breath-patterns/:id')
  async patch(@CurrentActor() a: Actor, @Param('id', Id) id: string, @Body(new Zod(PatternPatch)) b: z.infer<typeof PatternPatch>, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const r = await this.svc.updatePattern(a, id, b, m); res.header('etag', etag(r.version)); return r;
  }

  @AdminRoles(...MANAGER_ROLES) @HttpCode(204) @Delete('breath-patterns/:id')
  async remove(@CurrentActor() a: Actor, @Param('id', Id) id: string) { await this.svc.removePattern(a, id); }
}
