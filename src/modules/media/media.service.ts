import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../common/errors';
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
  z.object({ kind: z.literal('daily_message'), date, download: z.boolean().optional() }).strict(),
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
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly cdn: CdnSigner, private readonly entitlements: EntitlementService) {}

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
        const [v] = await this.db.select({ mediaId: motdVariants.mediaId }).from(motdVariants).where(and(eq(motdVariants.date, req.date), eq(motdVariants.lengthMin, req.lengthMin)));
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
        await this.requirePremium(userId);
        const [m] = await this.db.select().from(dailyMessages).where(and(eq(dailyMessages.date, req.date), eq(dailyMessages.status, 'live')));
        if (!m || !m.mediaId) throw new AppError('NOT_FOUND', 'No audio for this daily message');
        return this.sign(m.mediaId, m.type === 'video' ? 'video' : 'audio', download, m.durationSec);
      }
    }
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
