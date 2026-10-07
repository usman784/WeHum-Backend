import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { env } from '../config/env';
import { GroupStartService } from '../realtime/group-start.service';
import { CountersService } from '../modules/meditations/counters.service';
import { StatsProcessor } from '../modules/meditations/stats.processor';
import { AnalyticsService } from '../modules/analytics/analytics.service';
import { UserDataService } from '../modules/users-admin/user-data.service';
import { PushService } from '../modules/push/push.service';
import { RcProcessor } from '../modules/subscriptions/rc.processor';
import { MediaProcessor } from './media.processor';
import { PublishDueService } from './publish-due.service';
import { metrics } from '../infra/metrics';
import { bullConnection, QUEUES, QueueService } from './queues';

/** Consumer side (APP_ROLE=worker): media pipeline and the minute cron handlers. Tests call `start()` themselves. */
@Injectable()
export class WorkerRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('Workers');
  private workers: Worker[] = [];
  private conns: Redis[] = [];

  constructor(private readonly media: MediaProcessor, private readonly publishDue: PublishDueService, private readonly stats: StatsProcessor, private readonly counters: CountersService, private readonly moduleRef: ModuleRef, private readonly rc: RcProcessor) {}

  onModuleInit() { if (env.APP_ROLE === 'worker') this.start(); }

  start() {
    if (this.workers.length) return;
    const conn = () => { const c = bullConnection(); this.conns.push(c); return c; };
    this.workers = [
      new Worker(QUEUES.media, (job) => this.media.process(job.data.mediaId, job.data.jobId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)), { connection: conn(), concurrency: 2 }),
      new Worker(QUEUES.stats, (job) => this.stats.apply(job.data.meditationId), { connection: conn(), concurrency: 8 }),
      new Worker(QUEUES.cron, async (job) => {
        if (job.name === 'catalog.publishDue') return this.publishDue.run();
        if (job.name === 'counters.flush') return this.counters.flush();
        if (job.name === 'analytics.rollup') return this.moduleRef.get(AnalyticsService, { strict: false }).rollupRecent();
        if (job.name === 'data.lifecycle') return this.moduleRef.get(AnalyticsService, { strict: false }).lifecycle();
        if (job.name === 'user.export') return this.moduleRef.get(UserDataService, { strict: false }).exportUser(job.data.jobId, job.data.userId, job.data.emailTo ?? null);
        if (job.name === 'user.delete') return this.moduleRef.get(UserDataService, { strict: false }).deleteUser(job.data.jobId, job.data.userId, job.data.adminId ?? null);
        if (job.name === 'push.minute') return this.moduleRef.get(PushService, { strict: false }).minute();
        if (job.name === 'push.trial') return this.moduleRef.get(PushService, { strict: false }).trialEnding();
        if (job.name === 'rc.process') return this.rc.process(job.data.eventId);
        if (job.name === 'rc.reconcile') return this.rc.reconcile();
        // resolved lazily: the realtime module imports this one
        if (job.name === 'group.start') return this.moduleRef.get(GroupStartService, { strict: false }).fire(job.data.date, job.data.startsAt);
        this.log.warn(`unknown cron job ${job.name}`);
      }, { connection: conn(), concurrency: 1 }),
    ];
    for (const w of this.workers) {
      w.on('failed', (job, err) => {
        this.log.warn(`${w.name}:${job?.name} failed: ${err.message}`);
        if (job?.processedOn) metrics.jobDuration.observe({ queue: w.name, status: 'failed' }, ((job.finishedOn ?? Date.now()) - job.processedOn) / 1000);
      });
      w.on('completed', (job) => {
        if (job.processedOn) metrics.jobDuration.observe({ queue: w.name, status: 'done' }, ((job.finishedOn ?? Date.now()) - job.processedOn) / 1000);
      });
    }
  }

  /** Waits until the queue is drained (used by tests). */
  async idle(queues: readonly (typeof QUEUES)[keyof typeof QUEUES][], q: QueueService, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const counts = await Promise.all(queues.map((n) => q.queue(n).getJobCounts('waiting', 'active', 'delayed')));
      if (counts.every((c) => !c.waiting && !c.active && !c.delayed)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('queues did not drain');
  }

  async onApplicationShutdown() {
    await Promise.allSettled(this.workers.map((w) => w.close()));
    this.workers = [];
    for (const c of this.conns) c.disconnect();
    this.conns = [];
  }
}

