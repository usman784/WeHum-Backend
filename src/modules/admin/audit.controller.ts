import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { AdminRoles } from '../../common/auth';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import { Zod } from '../../common/zod';
import { auditLog, jobs } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { AppError } from '../../common/errors';
import { ALL_ROLES, MANAGER_ROLES } from '../admin-auth/rbac';

const AuditQuery = z.object({
  actorId: z.string().uuid().optional(), targetType: z.string().max(40).optional(), targetId: z.string().max(80).optional(),
  action: z.string().max(60).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
});

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('v1/admin')
export class AuditController {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  @AdminRoles(...MANAGER_ROLES) @Get('audit')
  async audit(@Query(new Zod(AuditQuery)) q: z.infer<typeof AuditQuery>) {
    const conds: (SQL | undefined)[] = [];
    if (q.actorId) conds.push(eq(auditLog.actorId, q.actorId));
    if (q.targetType) conds.push(eq(auditLog.targetType, q.targetType));
    if (q.targetId) conds.push(eq(auditLog.targetId, q.targetId));
    if (q.action) conds.push(eq(auditLog.action, q.action));
    if (q.from) conds.push(gte(auditLog.at, new Date(q.from)));
    if (q.to) conds.push(lte(auditLog.at, new Date(q.to)));
    const c = decodeCursor(q.cursor);
    if (c) conds.push(lt(auditLog.id, Number(c.k)));
    const limit = clampLimit(q.limit, 50);
    const rows = await this.db.select().from(auditLog).where(and(...conds)).orderBy(desc(auditLog.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { data: page.map((r) => ({ ...r, at: r.at.toISOString() })), meta: { nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.id, String(page.at(-1)!.id)) : null } };
  }

  @AdminRoles(...ALL_ROLES) @Get('jobs/:id')
  async job(@Param('id', new Zod(z.string().uuid())) id: string) {
    const [j] = await this.db.select().from(jobs).where(eq(jobs.id, id));
    if (!j) throw new AppError('NOT_FOUND', 'Job not found');
    return { id: j.id, type: j.type, status: j.status, progress: j.progress, result: j.result, error: j.error, createdAt: j.createdAt.toISOString(), updatedAt: j.updatedAt.toISOString() };
  }
}
