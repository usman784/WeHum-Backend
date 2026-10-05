import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { asc, eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { Zod } from '../../../common/zod';
import { teachers } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES } from '../../admin-auth/rbac';
import { AdminWriter, changed, CurrentActor, etag, lockVersioned, type Actor } from '../admin-writer';
import { IdParam, url, uuid as uuidDto } from '../dto';

const CreateDto = z.object({
  name: z.string().trim().min(1).max(80), role: z.string().trim().max(80).nullable().optional(), specialty: z.string().trim().max(120).nullable().optional(),
  bio: z.string().max(4000).nullable().optional(), quote: z.string().max(280).nullable().optional(),
  photoMediaId: uuidDto.nullable().optional(), photoUrl: url.nullable().optional(),
  youtubeUrl: url.nullable().optional(), instagramUrl: url.nullable().optional(), websiteUrl: url.nullable().optional(),
  visible: z.boolean().default(true), canLeadGroup: z.boolean().default(false),
}).strict();
const PatchDto = CreateDto.partial().strict();
type Row = typeof teachers.$inferSelect;

@Injectable()
export class TeachersService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter) {}

  list() { return this.db.select().from(teachers).orderBy(asc(teachers.name), asc(teachers.id)); }

  create(actor: Actor, b: z.infer<typeof CreateDto>) {
    const id = uuid();
    return this.writer.run(actor, { action: 'teacher.create', type: 'teacher', id, catalog: true }, async (tx) => {
      const [row] = await tx.insert(teachers).values({ id, ...b }).returning();
      return { result: row!, after: b, version: 1 };
    });
  }

  patch(actor: Actor, id: string, b: z.infer<typeof PatchDto>, ifMatch?: string) {
    return this.writer.run(actor, { action: 'teacher.update', type: 'teacher', id, catalog: true }, async (tx) => {
      const cur = await lockVersioned<Row>(tx, teachers, teachers.id, id, ifMatch, 'Teacher');
      const [row] = await tx.update(teachers).set({ ...b, version: cur.version + 1, updatedAt: new Date() }).where(eq(teachers.id, id)).returning();
      return { result: row!, ...changed(cur, { ...cur, ...b }), version: row!.version };
    });
  }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin/teachers')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Get() list() { return this.teachers.list(); }

  @HttpCode(201) @Post()
  async create(@CurrentActor() a: Actor, @Body(new Zod(CreateDto)) b: z.infer<typeof CreateDto>, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.teachers.create(a, b); res.header('etag', etag(row.version)); return row;
  }

  @Patch(':id')
  async patch(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Body(new Zod(PatchDto)) b: z.infer<typeof PatchDto>, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.teachers.patch(a, id, b, ifMatch); res.header('etag', etag(row.version)); return row;
  }
}
