import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from './redis';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Redis cache-aside with a stampede lock (spec §6.2): one caller loads, the others wait for the value. */
@Injectable()
export class CacheService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async getOrSet<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.redis.get(key).catch(() => null);
    if (hit !== null) return JSON.parse(hit) as T;
    const lock = `lock:${key}`;
    const got = await this.redis.set(lock, '1', 'PX', 5000, 'NX').catch(() => 'OK');
    if (got !== 'OK') {
      for (let i = 0; i < 20; i++) {
        await sleep(25);
        const v = await this.redis.get(key).catch(() => null);
        if (v !== null) return JSON.parse(v) as T;
      }
    }
    try {
      const value = await loader();
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSec).catch(() => null);
      return value;
    } finally {
      if (got === 'OK') await this.redis.del(lock).catch(() => null);
    }
  }

  del(...keys: string[]) { return this.redis.del(...keys).catch(() => 0); }
}
