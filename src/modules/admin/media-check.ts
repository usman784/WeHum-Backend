import { eq } from 'drizzle-orm';
import { AppError } from '../../common/errors';
import { mediaAssets } from '../../db/schema';
import type { DB } from '../../infra/core.module';
import type { Tx } from './admin-writer';

/** Media referenced by content must exist, be of the right kind and be fully processed. */
export async function readyMedia(db: DB | Tx, mediaId: string, kinds: string[]) {
  const [m] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
  if (!m) throw new AppError('NOT_FOUND', 'Media file not found');
  if (!kinds.includes(m.kind)) throw new AppError('VALIDATION_FAILED', `This file is ${m.kind}, expected ${kinds.join(' or ')}`);
  if (m.status !== 'ready') throw new AppError('MEDIA_NOT_READY', 'This file is still being processed');
  return m;
}
