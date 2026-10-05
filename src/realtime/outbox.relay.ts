import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { asc, inArray, isNull, sql } from 'drizzle-orm';
import { Client, type Pool } from 'pg';
import { env } from '../config/env';
import { outboxEvents } from '../db/schema';
import { DRIZZLE, PG_POOL, type DB } from '../infra/core.module';
import { RealtimeBus } from '../infra/realtime-bus';

const BATCH = 200, POLL_MS = 200;

/**
 * Transactional outbox → Redis (spec §3): rows written inside a business transaction are published only after it
 * commits (so a rolled-back write never produces an event). Pods claim batches with `FOR UPDATE SKIP LOCKED`, so many
 * API pods can run a relay without duplicating events; `NOTIFY` wakes them immediately, polling is the safety net.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('OutboxRelay');
  private timer?: NodeJS.Timeout;
  private listener?: Client;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(PG_POOL) private readonly pool: Pool, private readonly bus: RealtimeBus) {}

  async onModuleInit() {
    if (env.APP_ROLE !== 'api') return;
    await this.start();
  }

  async start() {
    this.timer = setInterval(() => void this.kick(), POLL_MS);
    await this.listen();
    void this.kick();
  }

  private async listen() {
    if (this.stopped) return;
    try {
      const c = new Client({ connectionString: env.DATABASE_URL, application_name: 'wehum-outbox-listener' });
      c.on('notification', () => void this.kick());
      c.on('error', (e) => { this.log.warn(`outbox listener lost: ${e.message}`); this.listener = undefined; setTimeout(() => void this.listen(), 1000); });
      await c.connect();
      await c.query('LISTEN outbox');
      this.listener = c;
    } catch (e) { this.log.warn(`outbox LISTEN failed: ${(e as Error).message}`); setTimeout(() => void this.listen(), 1000); }
  }

  /** Runs a drain; calls that arrive while one is running are folded into one more pass. */
  async kick() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try { do { this.again = false; while ((await this.drain()) === BATCH); } while (this.again); }
    catch (e) { this.log.warn(`outbox drain failed: ${(e as Error).message}`); }
    finally { this.running = false; }
  }

  /** Publishes one batch; returns how many events it handled. */
  async drain(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(outboxEvents).where(isNull(outboxEvents.publishedAt)).orderBy(asc(outboxEvents.id)).limit(BATCH).for('update', { skipLocked: true });
      if (!rows.length) return 0;
      await this.bus.publishMany(rows.map((r) => ({ topic: r.topic, payload: r.payload })));
      await tx.update(outboxEvents).set({ publishedAt: sql`now()` }).where(inArray(outboxEvents.id, rows.map((r) => r.id)));
      return rows.length;
    });
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.listener?.end().catch(() => null);
  }
}
