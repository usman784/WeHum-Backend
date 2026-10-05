import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import { AdminRoles } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { jobs, mediaAssets } from '../../db/schema';
import { CdnSigner } from '../../infra/cdn';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { S3Service } from '../../infra/s3';
import { QUEUES, QueueService } from '../../jobs/queues';
import { CONTENT_ROLES } from '../admin-auth/rbac';
import { AdminWriter, CurrentActor, type Actor } from './admin-writer';
import { IdParam } from './dto';

const MB = 1024 * 1024;
export const PART_SIZE = 10 * MB;
const LIMITS = { audio: { max: 500 * MB, mime: /^audio\/[\w.+-]+$/ }, video: { max: 2048 * MB, mime: /^video\/[\w.+-]+$/ }, image: { max: 10 * MB, mime: /^image\/(jpeg|png|webp|gif)$/ } } as const;
const UPLOAD_TTL_SEC = 24 * 3600;

const UploadDto = z.object({
  kind: z.enum(['audio', 'video', 'image']), mime: z.string().max(80), bytes: z.number().int().positive(), name: z.string().trim().min(1).max(200),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i, 'sha-256 hex').optional(),
}).strict();
const CompleteDto = z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(200) }).strict()).min(1).max(10000) }).strict();

const ext = (name: string, mime: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? mime.split('/')[1] ?? 'bin').toLowerCase();

/** Upload state kept in Redis while the browser sends parts straight to S3 (spec §8.5). */
interface UploadState { uploadId: string; key: string; bytes: number; partCount: number }

@Injectable()
export class MediaAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly writer: AdminWriter,
    private readonly s3: S3Service, private readonly queues: QueueService, private readonly cdn: CdnSigner,
  ) {}

  async start(actor: Actor, b: z.infer<typeof UploadDto>) {
    const rule = LIMITS[b.kind];
    if (!rule.mime.test(b.mime)) throw new AppError('VALIDATION_FAILED', `That is not a ${b.kind} file type`, { fields: [{ path: 'mime', message: `Not allowed for ${b.kind}` }] });
    if (b.bytes > rule.max) throw new AppError('PAYLOAD_TOO_LARGE', `${b.kind} files can be at most ${rule.max / MB} MB`);
    const duplicate = b.checksum ? (await this.db.select({ id: mediaAssets.id, name: mediaAssets.originalName }).from(mediaAssets).where(and(eq(mediaAssets.checksum, b.checksum.toLowerCase()), eq(mediaAssets.status, 'ready'))).limit(1))[0] : undefined;

    const id = uuid();
    const key = `media/${id}/v1/original.${ext(b.name, b.mime)}`;
    const partCount = Math.ceil(b.bytes / PART_SIZE);
    const uploadId = await this.s3.createMultipart(key, b.mime);
    await this.writer.run(actor, { action: 'media.create', type: 'media', id }, async (tx) => {
      await tx.insert(mediaAssets).values({ id, kind: b.kind, storageKey: key, originalName: b.name, mime: b.mime, bytes: b.bytes, checksum: b.checksum?.toLowerCase(), status: 'uploading', createdBy: actor.id });
      return { result: null, after: { kind: b.kind, name: b.name, bytes: b.bytes } };
    }).catch(async (e) => { await this.s3.abortMultipart(key, uploadId); throw e; });
    await this.redis.set(K.upload(id), JSON.stringify({ uploadId, key, bytes: b.bytes, partCount } satisfies UploadState), 'EX', UPLOAD_TTL_SEC);
    const parts = await Promise.all(Array.from({ length: partCount }, async (_, i) => ({ partNumber: i + 1, url: await this.s3.presignPart(key, uploadId, i + 1, 3600) })));
    return {
      id, uploadId, partSize: PART_SIZE, parts, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      duplicateOf: duplicate ? { id: duplicate.id, name: duplicate.name } : null,
    };
  }

  async complete(actor: Actor, id: string, parts: z.infer<typeof CompleteDto>['parts']) {
    const [m] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
    if (!m) throw new AppError('NOT_FOUND', 'Upload not found');
    if (m.status !== 'uploading') throw new AppError('INVALID_STATE', 'This upload was already completed');
    const raw = await this.redis.get(K.upload(id));
    if (!raw) throw new AppError('INVALID_STATE', 'This upload expired. Start it again.');
    const st = JSON.parse(raw) as UploadState;
    if (parts.length !== st.partCount || new Set(parts.map((p) => p.partNumber)).size !== parts.length || parts.some((p) => p.partNumber > st.partCount)) {
      throw new AppError('VALIDATION_FAILED', `Expected ${st.partCount} parts`, { fields: [{ path: 'parts', message: `Send each of the ${st.partCount} parts once` }] });
    }
    try { await this.s3.completeMultipart(st.key, st.uploadId, parts); }
    catch { throw new AppError('INVALID_STATE', 'The upload could not be assembled. Check that every part finished and try again.'); }
    if ((await this.s3.size(st.key)) !== st.bytes) {
      await this.s3.remove(st.key);
      await this.db.update(mediaAssets).set({ status: 'failed', error: 'The uploaded size did not match' }).where(eq(mediaAssets.id, id));
      throw new AppError('INVALID_STATE', 'The uploaded file is incomplete. Upload it again.');
    }
    const jobId = uuid();
    await this.writer.run(actor, { action: 'media.complete', type: 'media', id }, async (tx) => {
      await tx.update(mediaAssets).set({ status: 'processing' }).where(eq(mediaAssets.id, id));
      await tx.insert(jobs).values({ id: jobId, type: m.kind === 'image' ? 'image_process' : 'media_transcode', status: 'queued', payload: { mediaId: id }, createdBy: actor.id });
      return { result: null, before: { status: 'uploading' }, after: { status: 'processing', jobId } };
    });
    await this.redis.del(K.upload(id));
    await this.queues.add(QUEUES.media, 'process', { mediaId: id, jobId }, { jobId: `media-${id}`, attempts: 2, backoff: { type: 'fixed', delay: 5000 } });
    return { id, status: 'processing' as const, jobId };
  }

  async get(id: string) {
    const [m] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
    if (!m) throw new AppError('NOT_FOUND', 'Media not found');
    const [job] = await this.db.select().from(jobs).where(sql`${jobs.payload}->>'mediaId' = ${id}`).orderBy(desc(jobs.createdAt)).limit(1);
    const ready = m.status === 'ready';
    return {
      id: m.id, kind: m.kind, name: m.originalName, mime: m.mime, bytes: m.bytes, status: m.status, error: m.error, durationSec: m.durationSec,
      loudnessLufs: m.loudnessLufs === null ? null : Number(m.loudnessLufs), width: m.width, height: m.height, blurhash: m.blurhash, createdAt: m.createdAt.toISOString(),
      // short-lived preview for the CMS player / thumbnails
      previewUrl: ready ? (m.kind === 'image' ? this.cdn.publicUrl(m.storageKey) : this.cdn.signedUrl(m.storageKey, 3600).url) : null,
      job: job ? { id: job.id, status: job.status, progress: job.progress, result: job.result, error: job.error } : null,
    };
  }
}

@ApiTags('Admin Media')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin/media')
export class MediaAdminController {
  constructor(private readonly media: MediaAdminService) {}

  @HttpCode(201) @Post('uploads')
  start(@CurrentActor() a: Actor, @Body(new Zod(UploadDto)) b: z.infer<typeof UploadDto>) { return this.media.start(a, b); }

  @HttpCode(202) @Post('uploads/:id/complete')
  complete(@CurrentActor() a: Actor, @Param('id', new Zod(IdParam)) id: string, @Body(new Zod(CompleteDto)) b: z.infer<typeof CompleteDto>) { return this.media.complete(a, id, b.parts); }

  @Get(':id') get(@Param('id', new Zod(IdParam)) id: string) { return this.media.get(id); }
}
