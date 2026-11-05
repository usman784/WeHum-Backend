import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../../common/errors';
import { favoriteSessions, sessions } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { CdnSigner } from '../../infra/cdn';
import { coverMap, toSessionSummary } from './catalog.mapper';
import { sessionVisible } from './catalog.service';

const MAX_PER_USER = 500;

/** Members' favourite meditations. Membership is enforced by `@Member()` on the controller. */
@Injectable()
export class FavoritesService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly cdn: CdnSigner) {}

  /** Newest favourite first. Meditations that are no longer live are left out (the row stays, so a re-publish brings it back). */
  async list(userId: string) {
    const favs = await this.db.select({ sessionId: favoriteSessions.sessionId }).from(favoriteSessions)
      .where(eq(favoriteSessions.userId, userId)).orderBy(desc(favoriteSessions.createdAt), desc(favoriteSessions.sessionId)).limit(MAX_PER_USER);
    if (!favs.length) return { items: [] };
    const rows = await this.db.select().from(sessions).where(and(inArray(sessions.id, favs.map((f) => f.sessionId)), sessionVisible()));
    const byId = new Map(rows.map((s) => [s.id, s]));
    const covers = await coverMap(this.db, rows.map((s) => s.coverMediaId));
    return { items: favs.flatMap((f) => { const s = byId.get(f.sessionId); return s ? [toSessionSummary(s, this.cdn, covers)] : []; }) };
  }

  /** Idempotent: favouriting twice, or un-favouriting something that is not a favourite, is not an error. */
  async set(userId: string, sessionId: string, on: boolean) {
    if (on) {
      const [s] = await this.db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, sessionId), sessionVisible()));
      if (!s) throw new AppError('NOT_FOUND', 'Meditation not found');
      const [row] = await this.db.select({ n: count() }).from(favoriteSessions).where(eq(favoriteSessions.userId, userId));
      if ((row?.n ?? 0) >= MAX_PER_USER) throw new AppError('VALIDATION_FAILED', 'Too many favourites');
      await this.db.insert(favoriteSessions).values({ userId, sessionId }).onConflictDoNothing();
    } else {
      await this.db.delete(favoriteSessions).where(and(eq(favoriteSessions.userId, userId), eq(favoriteSessions.sessionId, sessionId)));
    }
    return { sessionId, favorited: on };
  }
}
