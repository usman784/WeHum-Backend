import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { env } from '../config/env';
import { MediaProcessor } from './media.processor';
import { PublishDueService } from './publish-due.service';
import { bullConnection, QUEUES, QueueService } from './queues';

/** Consumer side (APP_ROLE=worker): media pipeline and the minute cron handlers. Tests call `start()` themselves. */
@Injectable()
export class WorkerRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('Workers');
  private workers: Worker[] = [];
  private conns: Redis[] = [];

  constructor(private readonly media: MediaProcessor, private readonly publishDue: PublishDueService) {}

  onModuleInit() { if (env.APP_ROLE === 'worker') this.start(); }

  start() {
    if (this.workers.length) return;
    const conn = () => { const c = bullConnection(); this.conns.push(c); return c; };
    this.workers = [
      new Worker(QUEUES.media, (job) => this.media.process(job.data.mediaId, job.data.jobId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)), { connection: conn(), concurrency: 2 }),
      new Worker(QUEUES.cron, async (job) => {
        if (job.name === 'catalog.publishDue') return this.publishDue.run();
        this.log.warn(`unknown cron job ${job.name}`);
      }, { connection: conn(), concurrency: 1 }),
    ];
    for (const w of this.workers) w.on('failed', (job, err) => this.log.warn(`${w.name}:${job?.name} failed: ${err.message}`));
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

