import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { Zod } from '../../../common/zod';
import { challengeParticipants, challenges } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES } from '../../admin-auth/rbac';
import { AdminWriter, changed, CurrentActor, etag, lockVersioned, type Actor } from '../admin-writer';
import { IdParam, uuid as uuidDto } from '../dto';

const CreateDto = z.object({
  name: z.string().trim().min(1).max(80), days: z.number().int().min(1).max(365), counts: z.enum(['any', 'sleep', 'group']).default('any'),
  minMinutes: z.number().int().min(1).max(120).default(3), membersOnly: z.boolean().default(true), showOnYou: z.boolean().default(true),
  coverMediaId: uuidDto.nullable().optional(), startsAt: z.string().datetime().nullable().optional(),
}).strict();
const PatchDto = CreateDto.partial().extend({ status: z.enum(['draft', 'scheduled', 'live', 'archived']).optional() }).strict();
type Row = typeof challenges.$inferSelect;
const toDb = (b: { startsAt?: string | null }) => ({ ...b, startsAt: b.startsAt === undefined ? undefined : b.startsAt ? new Date(b.startsAt) : null });

/** Challenges ship "coming soon" (feature flag off): the CMS can prepare them, the app does not read them yet (P11). */
@Injectable()
export class ChallengesService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter) {}

  async list() {
    const [rows, counts] = await Promise.all([
      this.db.select().from(challenges).orderBy(desc(challenges.createdAt), desc(challenges.id)),
      this.db.select({ id: challengeParticipants.challengeId, n: sql<number>`count(*)::int`, done: sql<number>`(count(*) filter (where ${challengeParticipants.finishedAt} is not null))::int` })
        .from(challengeParticipants).groupBy(challengeParticipants.challengeId),
    ]);
    return rows.map((c) => { const x = counts.find((k) => k.id === c.id); return { ...c, participants: x?.n ?? 0, finished: x?.done ?? 0 }; });
  }

  create(actor: Actor, b: z.infer<typeof CreateDto>) {
    const id = uuid();
    return this.writer.run(actor, { action: 'challenge.create', type: 'challenge', id }, async (tx) => {
      const [row] = await tx.insert(challenges).values({ id, ...b, ...toDb(b) } as typeof challenges.$inferInsert).returning();
      return { result: row!, after: b, version: 1 };
    });
  }

  patch(actor: Actor, id: string, b: z.infer<typeof PatchDto>, ifMatch?: string) {
    return this.writer.run(actor, { action: 'challenge.update', type: 'challenge', id }, async (tx) => {
      const cur = await lockVersioned<Row>(tx, challenges, challenges.id, id, ifMatch, 'Challenge');
      const [row] = await tx.update(challenges).set({ ...b, ...toDb(b), version: cur.version + 1 } as Partial<typeof challenges.$inferInsert>).where(eq(challenges.id, id)).returning();
      return { result: row!, ...changed(cur, { ...cur, ...b }), version: row!.version };
    });
  }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin/challenges')
export class ChallengesController {
  constructor(private readonly challenges: ChallengesService) {}

  @Get() list() { return this.challenges.list(); }

  @HttpCode(201) @Post()
  async create(@CurrentActor() a: Actor, @Body(new Zod(CreateDto)) b: z.infer<typeof CreateDto>, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.challenges.create(a, b); res.header('etag', etag(row.version)); return row;
  }

  @Patch(':id')
  async patch(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Body(new Zod(PatchDto)) b: z.infer<typeof PatchDto>, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const row = await this.challenges.patch(a, id, b, m); res.header('etag', etag(row.version)); return row;
  }
}
