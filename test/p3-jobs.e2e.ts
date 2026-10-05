import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type Redis from 'ioredis';
import { Client } from 'pg';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { K, REDIS } from '../src/infra/redis';
import { QUEUES, QueueService } from '../src/jobs/queues';
import { SchedulerService } from '../src/jobs/scheduler';
import { WorkerRunner } from '../src/jobs/workers';
import { bootApp, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let redis: Redis;
let queues: QueueService;

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  redis = app.get(REDIS); queues = app.get(QueueService);
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
afterAll(async () => {
  await queues.queue(QUEUES.cron).obliterate({ force: true }).catch(() => null);
  await db?.end(); await app?.close();
});

describe('P3 scheduler + cron worker', () => {
  it('exactly one scheduler holds the lease; another takes over when it stops', async () => {
    await redis.del(K.leader);
    const a = new SchedulerService(redis, queues), b = new SchedulerService(redis, queues);
    await a.tick(); await b.tick();
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
    expect(await redis.pttl(K.leader)).toBeGreaterThan(10_000);
    await a.tick(); await b.tick(); // renewal keeps the same leader
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
    await a.onApplicationShutdown(); // graceful stop releases the lease
    await b.tick();
    expect(b.isLeader()).toBe(true);
    await b.onApplicationShutdown();
  });

  it('the leader registers the repeatable catalog.publishDue job (once, idempotently)', async () => {
    await redis.del(K.leader);
    const s = new SchedulerService(redis, queues);
    await s.tick();
    await s.register(); // registering again must not duplicate
    const schedulers = await queues.queue(QUEUES.cron).getJobSchedulers();
    const mine = schedulers.filter((x) => x.key === 'catalog.publishDue');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.every).toBe(60_000);
    await s.onApplicationShutdown();
  });

  it('the cron worker publishes due sessions', async () => {
    const mediaId = uuid(), id = uuid();
    await db.query(`INSERT INTO media_assets (id, kind, storage_key, mime, status, duration_sec) VALUES ($1,'audio',$2,'audio/mp4','ready',60)`, [mediaId, `t/${mediaId}`]);
    await db.query(`INSERT INTO sessions (id, slug, title, type, access, duration_sec, media_id, status, publish_at) VALUES ($1,$2,'Due Soon','audio','premium',60,$3,'scheduled', now() - interval '1 minute')`, [id, `due-${id.slice(-6)}`, mediaId]);
    const runner = app.get(WorkerRunner);
    runner.start();
    await queues.queue(QUEUES.cron).obliterate({ force: true });
    await queues.add(QUEUES.cron, 'catalog.publishDue', {});
    await runner.idle([QUEUES.cron], queues, 20_000);
    for (let i = 0; i < 50; i++) {
      if ((await db.query(`SELECT status FROM sessions WHERE id=$1`, [id])).rows[0].status === 'live') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await db.query(`SELECT status FROM sessions WHERE id=$1`, [id])).rows[0].status).toBe('live');
  });
});
