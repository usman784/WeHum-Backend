import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { encode } from 'blurhash';
import { jobs, mediaAssets, outboxEvents } from '../db/schema';
import { DRIZZLE, type DB } from '../infra/core.module';
import { S3Service } from '../infra/s3';
import { integratedLufs, loopCheck, probe, transcodeAudio, transcodeVideo } from './ffmpeg';

const MAX_AUDIO_SEC = 4 * 3600;
const IMAGE_WIDTHS = [1200, 600, 300] as const;
const LUFS_TARGET = -16, LUFS_TOLERANCE = 1;

class BadMedia extends Error {}

/** Media pipeline (spec §8.5): probe → loudness → transcode → upload for audio/video, `sharp` + blurhash for images. */
@Injectable()
export class MediaProcessor {
  private readonly log = new Logger('Media');
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly s3: S3Service) {}

  private async progress(jobId: string, patch: Partial<typeof jobs.$inferInsert>) {
    await this.db.transaction(async (tx) => {
      const [j] = await tx.update(jobs).set({ ...patch, updatedAt: new Date() }).where(eq(jobs.id, jobId)).returning({ id: jobs.id, status: jobs.status, progress: jobs.progress });
      if (j) await tx.insert(outboxEvents).values({ topic: 'job:progress', payload: { jobId: j.id, status: j.status, progress: j.progress } });
    });
  }

  /** Runs one asset through the pipeline. On the last attempt a failure is recorded on the asset so the CMS can show it. */
  async process(mediaId: string, jobId: string, lastAttempt = true) {
    const [m] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
    if (!m || m.status !== 'processing') return;
    const dir = await mkdtemp(join(tmpdir(), 'wehum-media-'));
    try {
      await this.progress(jobId, { status: 'running', progress: 5 });
      const original = join(dir, 'original');
      await this.s3.download(m.storageKey, original);
      const result = m.kind === 'image' ? await this.image(m, original, jobId) : await this.audioVideo(m, original, dir, jobId);
      await this.progress(jobId, { status: 'done', progress: 100, result: { ...result, originalKey: m.storageKey } });
    } catch (e) {
      const bad = e instanceof BadMedia;
      this.log.warn(`media ${mediaId} failed: ${(e as Error).message}`);
      if (bad || lastAttempt) {
        const message = bad ? (e as Error).message : 'Processing failed. Upload the file again.';
        await this.db.update(mediaAssets).set({ status: 'failed', error: message }).where(eq(mediaAssets.id, mediaId));
        await this.progress(jobId, { status: 'failed', error: message });
        if (bad) return; // retrying cannot fix a bad file
      }
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async audioVideo(m: typeof mediaAssets.$inferSelect, original: string, dir: string, jobId: string) {
    const p = await probe(original).catch(() => { throw new BadMedia(`This is not a valid ${m.kind} file`); });
    if (!p.hasAudio && m.kind === 'audio') throw new BadMedia('No audio found in this file');
    if (m.kind === 'video' && !p.hasVideo) throw new BadMedia('No video found in this file');
    if (p.durationSec < 1) throw new BadMedia('This file is empty');
    if (p.durationSec > MAX_AUDIO_SEC) throw new BadMedia('This file is longer than 4 hours');
    await this.progress(jobId, { progress: 20 });

    const lufs = p.hasAudio ? await integratedLufs(original) : null;
    await this.progress(jobId, { progress: 40 });

    const loop = m.kind === 'audio' ? await loopCheck(original, p.durationSec) : null;
    await this.progress(jobId, { progress: 55 });

    const video = m.kind === 'video';
    const out = join(dir, video ? 'out.mp4' : 'out.m4a');
    await (video ? transcodeVideo(original, out) : transcodeAudio(original, out));
    await this.progress(jobId, { progress: 85 });

    const key = `media/${m.id}/v1/${video ? 'video.mp4' : 'audio.m4a'}`;
    const mime = video ? 'video/mp4' : 'audio/mp4';
    await this.s3.uploadFile(key, out, mime);
    const final = await probe(out);
    await this.db.update(mediaAssets).set({
      status: 'ready', storageKey: key, mime, bytes: (await stat(out)).size, durationSec: final.durationSec || p.durationSec, loudnessLufs: lufs === null ? null : lufs.toFixed(2),
      width: final.width, height: final.height, error: null,
    }).where(eq(mediaAssets.id, m.id));
    const loudnessWarning = lufs !== null && Math.abs(lufs - LUFS_TARGET) > LUFS_TOLERANCE ? `Loudness ${lufs} LUFS is outside −16 ±1` : null;
    return { durationSec: final.durationSec, lufs, loudnessWarning, loop, codec: p.codec };
  }

  private async image(m: typeof mediaAssets.$inferSelect, original: string, jobId: string) {
    const img = sharp(original, { failOn: 'error' });
    const meta = await img.metadata().catch(() => { throw new BadMedia('This is not a valid image'); });
    if (!meta.width || !meta.height) throw new BadMedia('This is not a valid image');
    await this.progress(jobId, { progress: 25 });
    for (const w of IMAGE_WIDTHS) {
      await this.s3.putBuffer(`media/${m.id}/v1/${w}.webp`, await sharp(original).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(), 'image/webp');
    }
    await this.s3.putBuffer(`media/${m.id}/v1/1200.jpg`, await sharp(original).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer(), 'image/jpeg');
    await this.progress(jobId, { progress: 80 });
    const { data, info } = await sharp(original).rotate().resize(32, 32, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const blurhash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
    const oriented = meta.orientation && meta.orientation >= 5;
    await this.db.update(mediaAssets).set({
      status: 'ready', storageKey: `media/${m.id}/v1/1200.webp`, mime: 'image/webp', width: oriented ? meta.height : meta.width, height: oriented ? meta.width : meta.height, blurhash, error: null,
    }).where(eq(mediaAssets.id, m.id));
    return { widths: [...IMAGE_WIDTHS], blurhash };
  }
}
