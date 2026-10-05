import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env';

export const QUEUES = { media: 'media', cron: 'cron' } as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** BullMQ needs its own connections with `maxRetriesPerRequest: null`. */
export const bullConnection = () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/** Producer side: the API (and the scheduler) enqueue, the worker role consumes. */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly conn = bullConnection();

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
