import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../common/errors';
import { auditLog, dedications, jobs, outboxEvents, users } from '../../db/schema';
import { NEEDS_REVIEW } from '../community/community.service';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { RealtimeBus } from '../../infra/realtime-bus';
import { S3Service } from '../../infra/s3';
import { RevenueCatClient } from '../subscriptions/revenuecat.client';
import { PushTransport } from '../push/push.transport';
import { Mailer } from '../../infra/mailer';

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (rows: Record<string, unknown>[]) => { const head = rows[0] ? Object.keys(rows[0]) : []; return [head.join(','), ...rows.map((r) => head.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n'; };

/** Export and delete of one person's data (spec §4.4). Both run as jobs so the CMS can show progress and retry. */
@Injectable()
export class UserDataService {
  private readonly log = new Logger('UserData');
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly s3: S3Service, private readonly rc: RevenueCatClient, private readonly bus: RealtimeBus, private readonly push: PushTransport, private readonly mailer: Mailer) {}

  private async progress(jobId: string, patch: Partial<typeof jobs.$inferInsert>) {
    await this.db.transaction(async (tx) => {
      const [j] = await tx.update(jobs).set({ ...patch, updatedAt: new Date() }).where(eq(jobs.id, jobId)).returning({ id: jobs.id, status: jobs.status, progress: jobs.progress });
      if (j) await tx.insert(outboxEvents).values({ topic: 'job:progress', payload: { jobId: j.id, status: j.status, progress: j.progress } });
    });
  }

  async createJob(type: 'user_export' | 'user_delete', userId: string, adminId: string | null) {
    const id = uuidv7();
    await this.db.insert(jobs).values({ id, type, status: 'queued', payload: { userId }, createdBy: adminId });
    return id;
  }

  /** Everything we hold about this person, as JSON plus a meditations CSV, in storage with links valid for 24 hours. */
  async exportUser(jobId: string, userId: string, emailTo: string | null = null) {
    await this.progress(jobId, { status: 'running', progress: 10 });
    try {
      const q = async (s: ReturnType<typeof sql>) => (await this.db.execute<Record<string, unknown>>(s)).rows;
      const [u] = await q(sql`SELECT id, first_name, email, is_guest, country, timezone, locale, theme::text, reminder_enabled, reminder_time, group_warning, daily_message_push, show_country, muted_at, created_at, last_active_at FROM users WHERE id = ${userId}`);
      if (!u) throw new AppError('NOT_FOUND', 'User not found');
      const [identities, devices, stats, daily, meditations, recipes, dedications, blocks, entitlement, inbox, events] = await Promise.all([
        q(sql`SELECT provider::text, created_at FROM auth_identities WHERE user_id = ${userId}`),
        q(sql`SELECT platform::text, model, app_version, os_version, (push_token IS NOT NULL) AS push_enabled, created_at, last_seen_at FROM devices WHERE user_id = ${userId}`),
        q(sql`SELECT * FROM user_stats WHERE user_id = ${userId}`),
        q(sql`SELECT local_date::text, minutes, meditations, group_count FROM user_daily_stats WHERE user_id = ${userId} ORDER BY local_date`),
        q(sql`SELECT m.id, s.title AS session, m.kind::text, m.started_at, m.ended_at, m.duration_sec, m.counted, m.completed, m.local_date::text FROM meditations m LEFT JOIN sessions s ON s.id = m.session_id WHERE m.user_id = ${userId} ORDER BY m.started_at`),
        q(sql`SELECT * FROM recipes WHERE user_id = ${userId}`),
        q(sql`SELECT id, text, status::text, holding_count, created_at FROM dedications WHERE user_id = ${userId} ORDER BY created_at`),
        q(sql`SELECT blocked_id, created_at FROM user_blocks WHERE blocker_id = ${userId}`),
        q(sql`SELECT active, product_id, store::text, period_type::text, started_at, expires_at, will_renew, billing_issue FROM entitlements WHERE user_id = ${userId}`),
        q(sql`SELECT type, title, body, created_at, read_at FROM inbox_items WHERE user_id = ${userId} ORDER BY created_at`),
        q(sql`SELECT name, at FROM analytics_events WHERE user_id = ${userId} ORDER BY at LIMIT 5000`),
      ]);
      // P11 (coming soon): own posts, patterns, challenges and milestones
      const [gratitude, breathPatterns, challenges, milestones] = await Promise.all([
        q(sql`SELECT id, kind::text, text, status::text, created_at FROM gratitude_posts WHERE user_id = ${userId} ORDER BY created_at`),
        q(sql`SELECT name, inhale_sec, hold1_sec, exhale_sec, hold2_sec, rounds, created_at FROM user_breath_patterns WHERE user_id = ${userId} ORDER BY created_at`),
        q(sql`SELECT c.name, p.joined_at, p.completed_days, p.finished_at FROM challenge_participants p JOIN challenges c ON c.id = p.challenge_id WHERE p.user_id = ${userId}`),
        q(sql`SELECT key, reached_at FROM user_milestones WHERE user_id = ${userId} ORDER BY reached_at`),
      ]);
      await this.progress(jobId, { progress: 60 });
      const doc = { exportedAt: new Date().toISOString(), user: u, identities, devices, stats: stats[0] ?? null, dailyStats: daily, meditations, recipes, dedications, blocks, entitlement: entitlement[0] ?? null, inbox, events, gratitude, breathPatterns, challenges, milestones };
      const base = `exports/${userId}/${jobId}`;
      await this.s3.putBuffer(`${base}.json`, Buffer.from(JSON.stringify(doc, null, 2)), 'application/json');
      await this.s3.putBuffer(`${base}-meditations.csv`, Buffer.from(toCsv(meditations)), 'text/csv');
      const result = { json: await this.s3.presignGet(`${base}.json`), csv: await this.s3.presignGet(`${base}-meditations.csv`), meditations: meditations.length, expiresInHours: 24 };
      await this.progress(jobId, { status: 'done', progress: 100, result });
      if (emailTo) await this.mailer.send({ to: emailTo, subject: 'Your WeHum data export', text: `Your data is ready. The links work for 24 hours.\n\nAll data (JSON): ${result.json}\nMeditations (CSV): ${result.csv}\n` }).catch(() => null);
      return result;
    } catch (e) {
      await this.progress(jobId, { status: 'failed', error: (e as Error).message.slice(0, 500) });
      throw e;
    }
  }

  /** Delete first at RevenueCat (if it fails, nothing else has changed and the job can be run again), then storage, then the database. */
  async deleteUser(jobId: string, userId: string, adminId: string | null) {
    await this.progress(jobId, { status: 'running', progress: 10 });
    try {
      const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
      if (!u) throw new AppError('NOT_FOUND', 'User not found');
      await this.rc.deleteSubscriber(userId);
      // leave the FCM topic user_<id> while the tokens are still known (best effort)
      const tokens = (await this.db.execute<{ push_token: string }>(sql`SELECT push_token FROM devices WHERE user_id = ${userId} AND push_token IS NOT NULL`)).rows.map((r) => r.push_token);
      await this.push.unsubscribe(userId, tokens);
      await this.progress(jobId, { progress: 35 });
      const keys = await this.s3.listKeys(`exports/${userId}/`);
      for (const k of keys) await this.s3.remove(k);
      await this.progress(jobId, { progress: 55 });
      const removed = await this.db.execute<{ id: string; session_id: string }>(sql`SELECT id, session_id FROM dedications WHERE user_id = ${userId} AND status = 'visible'`);
      const removedPosts = await this.db.execute<{ id: string; kind: string }>(sql`SELECT id, kind::text FROM gratitude_posts WHERE user_id = ${userId} AND status = 'visible'`);
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM analytics_events WHERE user_id = ${userId}`);
        await tx.execute(sql`DELETE FROM push_log WHERE user_id = ${userId}`);
        await tx.execute(sql`UPDATE subscription_events SET user_id = NULL WHERE user_id = ${userId}`);
        await tx.delete(users).where(eq(users.id, userId)); // everything else cascades
        // no personal data in the audit entry: ids and counts only
        await tx.insert(auditLog).values({ actorId: adminId, actorRole: adminId ? 'admin' : 'system', action: 'user.delete', targetType: 'user', targetId: userId, after: { exportsDeleted: keys.length, dedicationsRemoved: removed.rows.length, revenueCat: true }, requestId: jobId.slice(0, 40) });
      });
      for (const d of removed.rows) await this.bus.publish('dedication:removed', { sessionId: d.session_id, id: d.id });
      for (const p of removedPosts.rows) await this.bus.publish('gratitude:removed', { kind: p.kind, id: p.id });
      await this.bus.publish('force:logout', { scope: 'user', id: userId, reason: 'account_deleted' }).catch(() => null);
      await this.bus.publish('moderation:count', { open: (await this.db.select({ n: sql<number>`count(*)::int` }).from(dedications).where(NEEDS_REVIEW))[0]!.n }).catch(() => null);
      await this.progress(jobId, { status: 'done', progress: 100, result: { deleted: true } });
    } catch (e) {
      await this.progress(jobId, { status: 'failed', error: (e as Error).message.slice(0, 500) });
      throw e;
    }
  }
}
