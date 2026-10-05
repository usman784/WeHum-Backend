import { Body, Controller, HttpCode, Injectable, Logger, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { Zod } from '../../../common/zod';
import { env } from '../../../config/env';
import { CONTENT_ROLES } from '../../admin-auth/rbac';

const ResolveDto = z.object({ url: z.string().trim().min(5).max(300) }).strict();

export function youtubeId(input: string): string | null {
  if (/^[\w-]{11}$/.test(input)) return input;
  let u: URL;
  try { u = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname);
    id = u.pathname === '/watch' ? u.searchParams.get('v') : m?.[1] ?? null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** ISO-8601 duration (PT1H2M3S) → seconds. */
export function isoDurationSec(d: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
  return m ? (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0) : 0;
}

/** Admin-only helper (never in a user request path): resolves a YouTube link to title, thumbnail and (with an API key) duration. */
@Injectable()
export class YoutubeService {
  /** Replaced in tests. */
  static fetchImpl: typeof fetch = (...a) => fetch(...a);
  private readonly log = new Logger('YouTube');

  private async get(url: string) {
    try { return await YoutubeService.fetchImpl(url, { signal: AbortSignal.timeout(5000) }); }
    catch (e) { this.log.warn(`YouTube lookup failed: ${(e as Error).message}`); throw new AppError('DEPENDENCY_DOWN', 'YouTube could not be reached. Try again.'); }
  }

  async resolve(input: string) {
    const id = youtubeId(input);
    if (!id) throw new AppError('VALIDATION_FAILED', 'That does not look like a YouTube link', { fields: [{ path: 'url', message: 'Not a YouTube link' }] });
    const unavailable = () => new AppError('YOUTUBE_UNAVAILABLE', 'This video is private, removed or cannot be embedded');
    const o = await this.get(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`);
    if ([401, 403, 404].includes(o.status)) throw unavailable();
    if (!o.ok) throw new AppError('DEPENDENCY_DOWN', 'YouTube could not be reached. Try again.');
    const meta = (await o.json()) as { title?: string; thumbnail_url?: string };
    let durationSec: number | null = null;
    if (env.YOUTUBE_API_KEY) {
      const r = await this.get(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,status&id=${id}&key=${env.YOUTUBE_API_KEY}`);
      if (r.ok) {
        const item = ((await r.json()) as { items?: { contentDetails?: { duration?: string }; status?: { embeddable?: boolean; privacyStatus?: string } }[] }).items?.[0];
        if (!item || item.status?.privacyStatus === 'private' || item.status?.embeddable === false) throw unavailable();
        durationSec = item.contentDetails?.duration ? isoDurationSec(item.contentDetails.duration) : null;
      }
    }
    return { youtubeId: id, title: meta.title ?? null, thumbnailUrl: meta.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, durationSec };
  }
}

@ApiTags('Admin Content')
@ApiBearerAuth()
@AdminRoles(...CONTENT_ROLES)
@Controller('v1/admin/youtube')
export class YoutubeController {
  constructor(private readonly youtube: YoutubeService) {}

  @HttpCode(200) @Post('resolve')
  resolve(@Body(new Zod(ResolveDto)) b: z.infer<typeof ResolveDto>) { return this.youtube.resolve(b.url); }
}
