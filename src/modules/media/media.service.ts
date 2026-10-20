import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors';
import { REDIS } from '../../infra/redis';
import { dailyMessages, mediaAssets, motdVariants, sessions, soundBlocks } from '../../db/schema';
import { CdnSigner } from '../../infra/cdn';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { sessionVisible } from '../catalog/catalog.service';
import { EntitlementService } from '../entitlements/entitlement.service';

export const PLAY_TTL_SEC = 6 * 3600;
export const DOWNLOAD_TTL_SEC = 7 * 86_400;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)), 'Invalid date');
export const PlayUrlBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), id: z.string().uuid(), download: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('motd'), date, lengthMin: z.union([z.literal(10), z.literal(30), z.literal(45)]), download: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('block'), id: z.string().uuid(), download: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('daily_message'), date, video: z.boolean().optional(), download: z.boolean().optional() }).strict(),
]);
export type PlayUrlRequest = z.infer<typeof PlayUrlBody>;

export interface PlayUrl {
  type: 'audio' | 'video' | 'youtube';
  url: string | null;
  hlsUrl: string | null;
  youtubeId: string | null;
  mime: string | null;
  durationSec: number | null;
  expiresAt: string | null;
}

/** Signed CDN URLs (spec §8.5). Premium content needs an active entitlement, checked server-side. */
@Injectable()
export class MediaService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly cdn: CdnSigner, private readonly entitlements: EntitlementService) {}

  async playUrl(userId: string, req: PlayUrlRequest): Promise<PlayUrl> {
    const download = !!req.download;
    switch (req.kind) {
      case 'session': {
        const [s] = await this.db.select().from(sessions).where(and(eq(sessions.id, req.id), sessionVisible()));
        if (!s) throw new AppError('NOT_FOUND', 'Meditation not found');
        if (s.access === 'premium') await this.requirePremium(userId);
        if (s.type === 'youtube') {
          if (download) throw new AppError('INVALID_STATE', 'This meditation cannot be downloaded');
          if (!s.youtubeId) throw new AppError('YOUTUBE_UNAVAILABLE', 'This meditation is not available right now');
          return { type: 'youtube', url: null, hlsUrl: null, youtubeId: s.youtubeId, mime: null, durationSec: s.durationSec, expiresAt: null };
        }
        if (download && (!s.downloadable || s.access === 'free')) throw new AppError('INVALID_STATE', 'This meditation cannot be downloaded');
        return this.sign(s.mediaId, s.type === 'video' ? 'video' : 'audio', download, s.durationSec);
      }
      case 'motd': {
        await this.requirePremium(userId);
        // Today's audio is not scheduled yet: play the most recent earlier one of this length. Today screen then shows a meditation
        // that starts, instead of "Not available" on a button that was offered.
        const [v] = await this.db.select({ mediaId: motdVariants.mediaId }).from(motdVariants)
          .where(and(lte(motdVariants.date, req.date), eq(motdVariants.lengthMin, req.lengthMin))).orderBy(desc(motdVariants.date)).limit(1);
        if (!v) throw new AppError('NOT_FOUND', 'No meditation of the day for this date and length');
        return this.sign(v.mediaId, 'audio', download, req.lengthMin * 60);
      }
      case 'block': {
        const [b] = await this.db.select().from(soundBlocks).where(and(eq(soundBlocks.id, req.id), eq(soundBlocks.visible, true)));
        if (!b) throw new AppError('NOT_FOUND', 'Sound block not found');
        if (b.access === 'premium') await this.requirePremium(userId);
        return this.sign(b.mediaId, 'audio', download, b.durationSec);
      }
      case 'daily_message': {
        const [m] = await this.db.select().from(dailyMessages).where(and(eq(dailyMessages.date, req.date), eq(dailyMessages.status, 'live')));
        if (!m) throw new AppError('NOT_FOUND', 'No daily message for this date');
        if (m.access === 'premium') await this.requirePremium(userId);
        if (download && m.access === 'free') throw new AppError('INVALID_STATE', 'This daily message cannot be downloaded');
        if (req.video) {
          const vid = m.type === 'video' ? m.mediaId : m.videoMediaId;
          if (!vid) throw new AppError('NOT_FOUND', 'No video for this daily message');
          return this.sign(vid, 'video', download, m.durationSec);
        }
        if (!m.mediaId) throw new AppError('NOT_FOUND', 'No audio for this daily message');
        return this.sign(m.mediaId, m.type === 'video' ? 'video' : 'audio', download, m.durationSec);
      }
    }
  }

  /**
   * 30-second preview of a locked premium audio meditation (Stitch). Members just get the normal URL. For everyone else:
   * the 30 s clip rendition when it exists (`enforced: 'clip'`), otherwise the file with a 10-minute URL and the app stops
   * at `previewSec` (`enforced: 'client'`). At most 10 previews per person and day.
   */
  async previewUrl(userId: string, sessionId: string) {
    const [s] = await this.db.select().from(sessions).where(and(eq(sessions.id, sessionId), sessionVisible()));
    if (!s) throw new AppError('NOT_FOUND', 'Meditation not found');
    if (s.type !== 'audio' || s.access !== 'premium' || !s.mediaId) throw new AppError('PREVIEW_NOT_AVAILABLE', 'This meditation has no preview');
    if (await this.entitlements.isActive(userId)) return { ...(await this.sign(s.mediaId, 'audio', false, s.durationSec)), previewSec: null, enforced: null, fullAccess: true };
    const key = `preview:${userId}:${new Date().toISOString().slice(0, 10)}`;
    const n = await this.redis.incr(key).catch(() => 0);
    if (n === 1) await this.redis.expire(key, 2 * 86_400).catch(() => 0);
    if (n > 10) throw new AppError('RATE_LIMITED', 'You have used today\'s previews. Try again tomorrow.');
    const [m] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, s.mediaId));
    if (!m || m.status !== 'ready') throw new AppError('MEDIA_NOT_READY', 'This meditation is still being prepared');
    const clip = m.previewKey ? this.cdn.signedUrl(m.previewKey, 600) : null, main = clip ?? this.cdn.signedUrl(m.storageKey, 600);
    return {
      type: 'audio' as const, url: main.url, hlsUrl: null, youtubeId: null, mime: m.mime, durationSec: clip ? 30 : m.durationSec, expiresAt: main.expiresAt,
      previewSec: 30, enforced: clip ? ('clip' as const) : ('client' as const), fullAccess: false, fullDurationSec: m.durationSec ?? s.durationSec,
    };
  }

  private async requirePremium(userId: string) {
    if (!(await this.entitlements.isActive(userId))) throw new AppError('PREMIUM_REQUIRED', 'A WeHum membership is needed for this meditation');
  }

  private async sign(mediaId: string | null, type: 'audio' | 'video', download: boolean, durationSec: number | null): Promise<PlayUrl> {
    if (!mediaId) throw new AppError('MEDIA_NOT_READY', 'This meditation has no media yet');
    const [m] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
    if (!m || m.status !== 'ready') throw new AppError('MEDIA_NOT_READY', 'This meditation is still being prepared');
    const ttl = download ? DOWNLOAD_TTL_SEC : PLAY_TTL_SEC;
    const main = this.cdn.signedUrl(m.storageKey, ttl);
    return {
      type, url: main.url, hlsUrl: !download && m.hlsKey ? this.cdn.signedUrl(m.hlsKey, ttl).url : null, youtubeId: null,
      mime: m.mime, durationSec: m.durationSec ?? durationSec, expiresAt: main.expiresAt,
    };
  }
}
