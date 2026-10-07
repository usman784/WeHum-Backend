import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CurrentUser, RateLimit, type AppUser } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { jobs, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { QUEUES, QueueService } from '../../jobs/queues';
import { UserDataService } from './user-data.service';

const DeleteSelf = z.object({ confirm: z.literal('DELETE') }).strict();
const JobId = new Zod(z.string().uuid());

/** Privacy & data (app spec §12 screen 59): the person exports or deletes their own data. Both are jobs, like the CMS ones. */
@ApiTags('Me')
@ApiBearerAuth()
@Controller('v1/me')
export class UserSelfController {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly data: UserDataService, private readonly queues: QueueService) {}

  /** Starts the export. People with an email get the links by email as well; the app can also poll `GET /v1/me/export/:jobId`. */
  @RateLimit('me-export', 3, 3600) @HttpCode(202) @Post('export')
  async startExport(@CurrentUser() u: AppUser) {
    const [row] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, u.id));
    const jobId = await this.data.createJob('user_export', u.id, null);
    await this.queues.add(QUEUES.cron, 'user.export', { jobId, userId: u.id, emailTo: row?.email ?? null }, { jobId: `export-${jobId}`, attempts: 2 });
    return { jobId };
  }

  @Get('export/:jobId')
  async exportStatus(@CurrentUser() u: AppUser, @Param('jobId', JobId) jobId: string) {
    const [j] = await this.db.select({ status: jobs.status, progress: jobs.progress, result: jobs.result }).from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.type, 'user_export'), sql`${jobs.payload}->>'userId' = ${u.id}`));
    if (!j) throw new AppError('NOT_FOUND', 'Export not found');
    return { status: j.status, progress: j.progress, result: j.status === 'done' ? j.result : null };
  }

  /** Marks the account deleted at once (it stops working everywhere), then the job removes RevenueCat, storage and the database rows. */
  @RateLimit('me-delete', 3, 3600) @HttpCode(202) @Delete()
  async remove(@CurrentUser() u: AppUser, @Body(new Zod(DeleteSelf)) _b: z.infer<typeof DeleteSelf>) {
    await this.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, u.id));
    const jobId = await this.data.createJob('user_delete', u.id, null);
    await this.queues.add(QUEUES.cron, 'user.delete', { jobId, userId: u.id, adminId: null }, { jobId: `delete-${jobId}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    return { jobId };
  }
}
