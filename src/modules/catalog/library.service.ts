import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BELTS, BELT_NAMES, beltsOf } from '../../common/belts';
import { CacheService } from '../../infra/cache';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { LiveService } from '../live/live.service';
import { utcToday } from '../motd/motd.service';

/** Header numbers and "sat today" counts for the Library (Stitch): real counts from today's completed sits. */
@Injectable()
export class LibraryService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly cache: CacheService, private readonly live: LiveService) {}

  summary() {
    return this.cache.getOrSet('library:summary', 30, async () => {
      const dayStart = new Date(`${utcToday()}T00:00:00Z`);
      const [snap, byTheme, top] = await Promise.all([
        this.live.snapshot(utcToday()),
        this.db.execute<{ theme_id: string; sits: number }>(sql`
          SELECT s.theme_id, count(*)::int AS sits FROM meditations m JOIN sessions s ON s.id = m.session_id
          WHERE m.counted AND m.started_at >= ${dayStart} AND s.theme_id IS NOT NULL GROUP BY s.theme_id`).then((r) => r.rows),
        this.db.execute<{ session_id: string; n: number }>(sql`
          SELECT m.session_id, count(DISTINCT m.user_id)::int AS n FROM meditations m JOIN sessions s ON s.id = m.session_id
          WHERE m.completed AND m.counted AND m.started_at >= ${dayStart} AND NOT s.is_sos AND s.status = 'live'
          GROUP BY m.session_id ORDER BY n DESC, m.session_id LIMIT 6`).then((r) => r.rows),
      ]);
      const belts = snap.belts ?? beltsOf(snap.top);
      return {
        sittingNow: snap.total, quiet: snap.quiet,
        regions: BELTS.map((key) => ({ key, name: BELT_NAMES[key], sittingNow: belts[key] })),
        disciplines: byTheme.map((t) => ({ id: t.theme_id, sitsToday: t.sits })),
        topToday: top.map((t) => ({ sessionId: t.session_id, completedToday: t.n })),
        at: Date.now(),
      };
    });
  }
}
