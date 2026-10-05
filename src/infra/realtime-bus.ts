import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../config/env';
import { REDIS } from './redis';

export const EVENTS_CHANNEL = 'events';
export interface BusEvent { topic: string; payload: unknown }

/**
 * Everything realtime goes through one Redis channel (spec §3): the outbox relay, the scheduler, the workers and the
 * API pods all `publish`; every API pod `subscribe`s and emits to its own sockets. Processes without sockets can publish too.
 */
@Injectable()
export class RealtimeBus implements OnApplicationShutdown {
  private readonly log = new Logger('RealtimeBus');
  private sub?: Redis;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async publish(topic: string, payload: unknown) {
    await this.redis.publish(EVENTS_CHANNEL, JSON.stringify({ topic, payload } satisfies BusEvent));
  }

  async publishMany(events: BusEvent[]) {
    if (!events.length) return;
    const p = this.redis.pipeline();
    for (const e of events) p.publish(EVENTS_CHANNEL, JSON.stringify(e));
    await p.exec();
  }

  async subscribe(handler: (e: BusEvent) => void) {
    this.sub ??= new Redis(env.REDIS_URL);
    this.sub.on('message', (_ch, msg) => {
      try { handler(JSON.parse(msg) as BusEvent); } catch (e) { this.log.warn(`bad bus message: ${(e as Error).message}`); }
    });
    await this.sub.subscribe(EVENTS_CHANNEL);
  }

  async onApplicationShutdown() { this.sub?.disconnect(); }
}
