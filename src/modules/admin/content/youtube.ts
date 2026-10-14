import { Body, Controller, HttpCode, Inject, Injectable, Logger, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, eq, isNull, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { Zod } from '../../../common/zod';
import { env } from '../../../config/env';
import { sessions } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { CONTENT_ROLES } from '../../admin-auth/rbac';
import { AdminWriter, SYSTEM_ACTOR } from '../admin-writer';

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

/** The text YouTube shows under a video (links included), capped so one video cannot bloat the catalog. */
export const DESCRIPTION_MAX = 4000;
const clean = (t: string) => t.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, DESCRIPTION_MAX);

/** Admin-only helper (never in a user request path): resolves a YouTube link to title, thumbnail, description and (with an API key) duration. */
@Injectable()
export class YoutubeService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter) {}

  /** Replaced in tests. */
  static fetchImpl: typeof fetch = (...a) => fetch(...a);
  private readonly log = new Logger('YouTube');

  private async get(url: string) {
    try { return await YoutubeService.fetchImpl(url, { signal: AbortSignal.timeout(5000) }); }
    catch (e) { this.log.warn(`YouTube lookup failed: ${(e as Error).message}`); throw new AppError('DEPENDENCY_DOWN', 'YouTube could not be reached. Try again.'); }
  }

  /**
   * The video's description. With an API key it comes from the Data API; without one, from the public watch page
   * (`shortDescription` in the player data). Returns null when neither works: the description is a nice-to-have, never a reason to fail.
   */
  async describe(id: string): Promise<string | null> {
    try {
      if (env.YOUTUBE_API_KEY) {
        const r = await this.get(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${env.YOUTUBE_API_KEY}`);
        if (r.ok) {
          const d = ((await r.json()) as { items?: { snippet?: { description?: string } }[] }).items?.[0]?.snippet?.description;
          if (typeof d === 'string') return clean(d) || null;
        }
      }
      const page = await YoutubeService.fetchImpl(`https://www.youtube.com/watch?v=${id}`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'accept-language': 'en', cookie: 'CONSENT=YES+1; SOCS=CAI' },
      });
      if (!page.ok) return null;
      const m = /"shortDescription":"((?:\\.|[^"\\])*)"/.exec(await page.text());
      return m ? clean(JSON.parse(`"${m[1]}"`) as string) || null : null;
    } catch (e) { this.log.warn(`description lookup failed for ${id}: ${(e as Error).message}`); return null; }
  }

  /** Fills the description of every YouTube meditation that has none yet (or all of them with `all`). */
  async backfill(all = false): Promise<{ checked: number; filled: number }> {
    const rows = await this.db.select({ id: sessions.id, yt: sessions.youtubeId }).from(sessions)
      .where(and(isNotNull(sessions.youtubeId), all ? undefined : or(isNull(sessions.description), eq(sessions.description, ''))));
    let filled = 0;
    for (const r of rows) {
      const d = await this.describe(r.yt!);
      if (!d) continue;
      await this.writer.run(SYSTEM_ACTOR('youtube.describe'), { action: 'session.describe', type: 'session', id: r.id, catalog: true }, async (tx) => {
        await tx.update(sessions).set({ description: d, updatedAt: new Date(), version: sql`${sessions.version} + 1` }).where(eq(sessions.id, r.id));
        return { result: null, after: { description: d.slice(0, 80) } };
      });
      filled++;
    }
    return { checked: rows.length, filled };
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
    // Non-blocking notes for the CMS: 'short' / 'unlisted' get fewer ads from YouTube ("no ads in the app" is expected, not a bug);
    // 'unverified' = no Data API answer, so embeddable / "made for kids" were not checked (set YOUTUBE_API_KEY).
    const warnings: string[] = [];
    let verified = false; // the Data API answered: embeddable, private, "made for kids" were really checked
    if (/\/shorts\//.test(input)) warnings.push('short');
    if (env.YOUTUBE_API_KEY) {
      const r = await this.get(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,status&id=${id}&key=${env.YOUTUBE_API_KEY}`);
      if (r.ok) {
        const item = ((await r.json()) as { items?: { contentDetails?: { duration?: string }; status?: { embeddable?: boolean; privacyStatus?: string; madeForKids?: boolean } }[] }).items?.[0];
        if (!item || item.status?.privacyStatus === 'private' || item.status?.embeddable === false) throw unavailable();
        // "made for kids" videos get no personalised ads and limited ad serving: refuse them for the free library
        if (item.status?.madeForKids === true) throw new AppError('YOUTUBE_UNAVAILABLE', 'This video is marked “made for kids” on YouTube, which limits ads. Pick another video.');
        if (item.status?.privacyStatus === 'unlisted') warnings.push('unlisted');
        durationSec = item.contentDetails?.duration ? isoDurationSec(item.contentDetails.duration) : null;
        verified = true;
      }
    }
    if (!verified) warnings.push('unverified');
    return { youtubeId: id, description: await this.describe(id), title: meta.title ?? null, thumbnailUrl: meta.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, durationSec, warnings };
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

  /** "Fetch missing descriptions" for the YouTube items already in the catalog. */
  @HttpCode(200) @Post('descriptions')
  descriptions(@Body() b: { all?: boolean }) { return this.youtube.backfill(b?.all === true); }
}
