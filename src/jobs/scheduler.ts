import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { K, REDIS } from '../infra/redis';
import { QUEUES, QueueService } from './queues';

const LEASE_MS = 15_000, RENEW_MS = 5_000;

/** Leader-elected scheduler (APP_ROLE=scheduler): one pod holds `scheduler:leader` and registers the repeatable jobs (spec §8.7). */
@Injectable()
export class SchedulerService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('Scheduler');
  private readonly podId = randomUUID();
  private timer?: NodeJS.Timeout;
  private leader = false;

  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly queues: QueueService) {}

  onModuleInit() { if (env.APP_ROLE === 'scheduler') void this.start(); }

  isLeader() { return this.leader; }

  async start() {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), RENEW_MS);
  }

  /** `SET NX PX` to take the lease, extend it while we hold it. */
  async tick() {
    try {
      const got = await this.redis.set(K.leader, this.podId, 'PX', LEASE_MS, 'NX');
      const holds = got === 'OK' || (await this.redis.get(K.leader)) === this.podId;
      if (holds && got !== 'OK') await this.redis.pexpire(K.leader, LEASE_MS);
      if (holds && !this.leader) { this.leader = true; this.log.log('became leader'); await this.register(); }
      if (!holds && this.leader) { this.leader = false; this.log.log('lost leadership'); }
    } catch (e) { this.log.warn(`leader tick failed: ${(e as Error).message}`); }
  }

  /** Idempotent: re-registering the same scheduler id just updates it. */
  async register() {
    await this.queues.queue(QUEUES.cron).upsertJobScheduler('catalog.publishDue', { every: 60_000 }, { name: 'catalog.publishDue', opts: { removeOnComplete: 100, removeOnFail: 500 } });
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    if (this.leader && (await this.redis.get(K.leader).catch(() => null)) === this.podId) await this.redis.del(K.leader).catch(() => 0);
  }
}
