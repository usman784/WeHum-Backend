import { metrics, onScrape } from '../infra/metrics';
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env';

export const QUEUES = { media: 'media', cron: 'cron', stats: 'stats' } as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** BullMQ needs its own connections with `maxRetriesPerRequest: null`. */
export const bullConnection = () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/** Producer side: the API (and the scheduler) enqueue, the worker role consumes. */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly conn = bullConnection();

  constructor() {
    onScrape(async () => {
      for (const name of Object.values(QUEUES)) {
        const c = await this.queue(name).getJobCounts('waiting', 'delayed', 'prioritized');
        metrics.queueDepth.set({ queue: name }, (c.waiting ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0));
      }
    });
  }

  queue(name: QueueName) {
    let q = this.queues.get(name);
    if (!q) { q = new Queue(name, { connection: this.conn }); this.queues.set(name, q); }
    return q;
  }

  add(name: QueueName, job: string, data: Record<string, unknown>, opts: JobsOptions = {}) {
    return this.queue(name).add(job, data, { removeOnComplete: 1000, removeOnFail: 5000, ...opts });
  }

  async onApplicationShutdown() {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.conn.disconnect();
  }
}
