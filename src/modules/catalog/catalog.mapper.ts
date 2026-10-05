import { inArray } from 'drizzle-orm';
import { mediaAssets, type sessions } from '../../db/schema';
import type { DB } from '../../infra/core.module';
import type { CdnSigner } from '../../infra/cdn';

type SessionRow = typeof sessions.$inferSelect;
export type Cover = { url: string; blurhash: string | null } | null;

/** Loads cover media rows in one query (no N+1) → id → {key, blurhash}. */
export async function coverMap(db: DB, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (!wanted.length) return new Map<string, { key: string; blurhash: string | null }>();
  const rows = await db.select({ id: mediaAssets.id, key: mediaAssets.storageKey, blurhash: mediaAssets.blurhash }).from(mediaAssets).where(inArray(mediaAssets.id, wanted));
  return new Map(rows.map((r) => [r.id, { key: r.key, blurhash: r.blurhash }]));
}

export function toCover(cdn: CdnSigner, covers: Awaited<ReturnType<typeof coverMap>>, mediaId: string | null, url: string | null): Cover {
  const m = mediaId ? covers.get(mediaId) : undefined;
  const u = m ? cdn.publicUrl(m.key) : cdn.publicUrl(url);
  return u ? { url: u, blurhash: m?.blurhash ?? null } : null;
}

/**
 * Public session shape. Never exposes storage keys; `youtubeId` is only sent for free items
 * (premium items are played through POST /v1/media/play-url).
 */
export function toSessionSummary(s: SessionRow, cdn: CdnSigner, covers: Awaited<ReturnType<typeof coverMap>>) {
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    description: s.description,
    type: s.type,
    access: s.access,
    themeId: s.themeId,
    teacherId: s.teacherId,
    tags: s.tags,
    durationSec: s.durationSec,
    cover: toCover(cdn, covers, s.coverMediaId, s.coverUrl),
    youtubeId: s.access === 'free' ? s.youtubeId : null,
    downloadable: s.access === 'premium' && s.downloadable && s.type !== 'youtube',
    version: s.version,
  };
}
