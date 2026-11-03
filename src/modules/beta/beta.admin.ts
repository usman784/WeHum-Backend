import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminRoles, RateLimit } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { CONTENT_ROLES, MANAGER_ROLES } from '../admin-auth/rbac';
import { CurrentActor, type Actor } from '../admin/admin-writer';
import { cursorQuery, IdParam } from '../admin/dto';
import { PREFIX_RE, IMPORT_TEMPLATE } from './beta.logins';
import { BetaService, type BulkAction } from './beta.service';

const Id = new Zod(IdParam);
const Preset = z.enum(['blank', 'profile', 'light']);

const Filter = z.object({
  batchId: z.string().uuid().optional(), q: z.string().trim().max(80).optional(),
  access: z.enum(['free', 'beta', 'paid']).optional(), state: z.enum(['active', 'suspended', 'deleting']).optional(), presence: z.enum(['online', 'offline']).optional(),
}).strict();
const ListQuery = Filter.extend(cursorQuery);

const CreateDto = z.object({
  name: z.string().trim().min(2).max(80),
  count: z.number().int().min(1).max(1000),
  prefix: z.string().regex(PREFIX_RE, 'Lowercase letters and digits, starting with a letter (2–14 characters)'),
  access: z.enum(['free', 'premium', 'mixed']),
  premiumCount: z.number().int().min(0).optional(),
  freeCount: z.number().int().min(0).optional(),
  premiumDays: z.number().int().min(1).max(365).optional(),
  premiumExpiresAt: z.string().datetime().optional(),
  seedPreset: Preset.default('blank'),
}).strict();
const ImportDto = z.object({ csv: z.string().min(10).max(200_000), name: z.string().trim().min(2).max(80).optional(), skipInvalid: z.boolean().default(false), seedPreset: Preset.default('blank') }).strict();

const Selection = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }).strict(),
  z.object({ all: z.literal(true), filter: Filter }).strict(),
]);
const Params = z.object({ days: z.number().int().min(1).max(365).optional(), expiresAt: z.string().datetime().optional(), reason: z.string().trim().max(200).optional(), confirm: z.string().max(120).optional() }).strict();
const ACTIONS = ['grant', 'extend', 'remove', 'suspend', 'resume', 'delete', 'reset_sample'] as const;
const BulkDto = z.object({ action: z.enum(ACTIONS), selection: Selection, params: Params.default({}), expectedCount: z.number().int().min(0).optional() }).strict();
const ReviewDto = z.object({ selection: Selection }).strict();
const OneDto = z.object({ action: z.enum([...ACTIONS, 'reset_password', 'reset_progress']), params: Params.default({}) }).strict();

/** Beta Testers: read for content roles, every change for owner/admin only. A regular member id is "not found" on every route. */
@ApiTags('Admin Beta Testers')
@ApiBearerAuth()
@Controller('v1/admin/beta')
export class BetaAdminController {
  constructor(private readonly beta: BetaService) {}

  @AdminRoles(...CONTENT_ROLES) @Get('summary') summary(@Query(new Zod(z.object({ batchId: z.string().uuid().optional() }))) q: { batchId?: string }) { return this.beta.summary(q.batchId); }
  @AdminRoles(...CONTENT_ROLES) @Get('users') list(@Query(new Zod(ListQuery)) q: z.infer<typeof ListQuery>) { const { cursor, limit, ...f } = q; return this.beta.list(f, cursor, limit); }

  @AdminRoles(...MANAGER_ROLES) @Get('users/export')
  async exportList(@Query(new Zod(Filter)) q: z.infer<typeof Filter>, @Res() res: FastifyReply) {
    void res.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="wehum-beta-testers.csv"').send(await this.beta.listCsv(q));
  }

  @AdminRoles(...CONTENT_ROLES) @Get('batches') batches() { return this.beta.batches(); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(200) @Post('batches/preview') preview(@Body(new Zod(CreateDto)) b: z.infer<typeof CreateDto>) { return this.beta.preview(b); }
  @AdminRoles(...MANAGER_ROLES) @RateLimit('beta-create', 5, 60) @HttpCode(202) @Post('batches') create(@CurrentActor() a: Actor, @Body(new Zod(CreateDto)) b: z.infer<typeof CreateDto>) { return this.beta.createBatch(a, b); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(202) @Post('batches/:id/retry') retryBatch(@CurrentActor() a: Actor, @Param('id', Id) id: string) { return this.beta.retryBatch(a, id); }

  /** Initial login/password pairs for one group: restricted, rate-limited, audited, never cached. */
  @AdminRoles(...MANAGER_ROLES) @RateLimit('beta-secrets', 10, 60) @Header('cache-control', 'no-store') @Get('batches/:id/credentials')
  async credentials(@CurrentActor() a: Actor, @Param('id', Id) id: string, @Res() res: FastifyReply) {
    const csv = await this.beta.credentialsCsv(a, id);
    void res.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="wehum-beta-credentials.csv"').header('cache-control', 'no-store').send(csv);
  }

  @AdminRoles(...CONTENT_ROLES) @Get('import/template')
  template(@Res() res: FastifyReply) { void res.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="wehum-beta-import-template.csv"').send(IMPORT_TEMPLATE); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(200) @Post('import/preview') importPreview(@Body(new Zod(ImportDto.pick({ csv: true }))) b: { csv: string }) { return this.beta.previewImport(b.csv); }
  @AdminRoles(...MANAGER_ROLES) @RateLimit('beta-create', 5, 60) @HttpCode(202) @Post('import')
  import(@CurrentActor() a: Actor, @Body(new Zod(ImportDto)) b: z.infer<typeof ImportDto>) { return this.beta.importBatch(a, b.name ?? 'Imported testers', b.csv, b.skipInvalid, b.seedPreset); }

  /** Review before a destructive bulk action: exact scope, protected accounts and the phrase to type. */
  @AdminRoles(...MANAGER_ROLES) @HttpCode(200) @Post('bulk/review')
  async review(@Body(new Zod(ReviewDto)) b: z.infer<typeof ReviewDto>) { const ids = await this.beta.resolve(b.selection); const { ids: _ids, ...rv } = await this.beta.reviewDelete(ids); return { ...rv, selected: ids.length }; }

  @AdminRoles(...MANAGER_ROLES) @RateLimit('beta-bulk', 20, 60) @HttpCode(202) @Post('bulk')
  async bulk(@CurrentActor() a: Actor, @Body(new Zod(BulkDto)) b: z.infer<typeof BulkDto>) {
    const ids = await this.beta.resolve(b.selection);
    return this.beta.startBulk(a, b.action as BulkAction, ids, b.params, b.expectedCount);
  }

  @AdminRoles(...CONTENT_ROLES) @Get('jobs/:id') job(@Param('id', Id) id: string) { return this.beta.job(id); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(202) @Post('jobs/:id/retry') retryJob(@CurrentActor() a: Actor, @Param('id', Id) id: string) { return this.beta.retryJob(a, id); }

  @AdminRoles(...CONTENT_ROLES) @Get('users/:id/sample') sample(@Param('id', Id) id: string) { return this.beta.samplePreview(id); }

  /** One account, same service as the bulk job. Deleting always goes through the job (block first, clean up after). */
  @AdminRoles(...MANAGER_ROLES) @RateLimit('beta-one', 60, 60) @Header('cache-control', 'no-store') @HttpCode(200) @Post('users/:id/action')
  async one(@CurrentActor() a: Actor, @Param('id', Id) id: string, @Body(new Zod(OneDto)) b: z.infer<typeof OneDto>) {
    const p = b.params;
    switch (b.action) {
      case 'grant': {
        const at = p.expiresAt ? new Date(p.expiresAt) : p.days ? new Date(Date.now() + p.days * 86_400_000) : null;
        if (!at) throw new AppError('VALIDATION_FAILED', 'Choose a number of days or an end date');
        return this.beta.grant(a, id, at);
      }
      case 'extend': if (!p.days) throw new AppError('VALIDATION_FAILED', 'Choose how many days to add'); return this.beta.extend(a, id, p.days);
      case 'remove': return this.beta.remove(a, id);
      case 'suspend': return this.beta.suspend(a, id, p.reason ?? 'Suspended by an admin');
      case 'resume': return this.beta.resume(a, id);
      case 'reset_sample': return this.beta.resetSample(a, id);
      case 'reset_password': return this.beta.resetPassword(a, id);
      case 'reset_progress':
        if (p.confirm !== 'RESET PROGRESS') throw new AppError('VALIDATION_FAILED', 'Type RESET PROGRESS to confirm', { fields: [{ path: 'confirm', message: 'Type RESET PROGRESS' }] });
        return this.beta.resetProgress(a, id);
      case 'delete': {
        const ids = await this.beta.resolve({ ids: [id] });
        return this.beta.startBulk(a, 'delete', ids, p);
      }
    }
  }
}
