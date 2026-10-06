import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lte, sql } from 'drizzle-orm';
import { dailyMessages, mediaAssets, sessions } from '../db/schema';
import { DRIZZLE, type DB } from '../infra/core.module';
import { AdminWriter, SYSTEM_ACTOR } from '../modules/admin/admin-writer';

/** `catalog.publishDue` (spec §8.7, every minute): scheduled meditations whose time has come go live and the catalog version is bumped once. */
@Injectable()
export class PublishDueService {
  private readonly log = new Logger('PublishDue');
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter) {}

  async run(): Promise<number> {
    const system = SYSTEM_ACTOR('catalog.publishDue');
    const due = await this.db.select({ id: sessions.id, type: sessions.type, mediaId: sessions.mediaId, youtubeId: sessions.youtubeId })
      .from(sessions).where(and(eq(sessions.status, 'scheduled'), lte(sessions.publishAt, sql`now()`))).limit(200);
    let published = 0;
    for (const s of due) {
      const ok = await this.writer.run(system, { action: 'session.publish', type: 'session', id: s.id }, async (tx) => {
        const [cur] = await tx.select().from(sessions).where(and(eq(sessions.id, s.id), eq(sessions.status, 'scheduled'))).for('update');
        if (!cur) return { result: false };
        const playable = cur.type === 'youtube' ? !!cur.youtubeId
          : !!cur.mediaId && (await tx.select({ st: mediaAssets.status }).from(mediaAssets).where(eq(mediaAssets.id, cur.mediaId)))[0]?.st === 'ready';
        if (!playable) { this.log.warn(`session ${s.id} is due but has no playable media; left scheduled`); return { result: false }; }
        const [row] = await tx.update(sessions).set({ status: 'live', version: cur.version + 1, updatedAt: new Date() }).where(eq(sessions.id, s.id)).returning({ version: sessions.version });
        return { result: true, before: { status: 'scheduled' }, after: { status: 'live' }, version: row!.version };
      });
      if (ok) published++;
    }
    if (published) await this.writer.run(system, { action: 'catalog.bump', type: 'session', id: 'catalog', catalog: true }, async () => ({ result: null, after: { published } }));
    await this.publishMessages(system);
    return published;
  }

  /** Daily messages set to "scheduled" go live on their day (UTC). The count of meditations is what `run` returns. */
  async publishMessages(system = SYSTEM_ACTOR('catalog.publishDue')): Promise<number> {
    const due = await this.db.select({ date: dailyMessages.date }).from(dailyMessages)
      .where(and(eq(dailyMessages.status, 'scheduled'), lte(dailyMessages.date, sql`(now() at time zone 'utc')::date`))).limit(100);
    let live = 0;
    for (const m of due) {
      const ok = await this.writer.run(system, { action: 'dailyMessage.publish', type: 'dailyMessage', id: m.date }, async (tx) => {
        const [cur] = await tx.select().from(dailyMessages).where(and(eq(dailyMessages.date, m.date), eq(dailyMessages.status, 'scheduled'))).for('update');
        if (!cur) return { result: false };
        const hasContent = cur.type === 'text' ? !!cur.text?.trim() : !!cur.mediaId;
        if (!hasContent) { this.log.warn(`daily message ${m.date} is due but has no content; left scheduled`); return { result: false }; }
        const [row] = await tx.update(dailyMessages).set({ status: 'live', version: cur.version + 1, updatedAt: new Date() }).where(eq(dailyMessages.date, m.date)).returning({ version: dailyMessages.version });
        return { result: true, before: { status: 'scheduled' }, after: { status: 'live' }, version: row!.version };
      });
      if (ok) live++;
    }
    return live;
  }
}
