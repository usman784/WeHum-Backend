import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { K, REDIS } from '../../infra/redis';
import { ConfigService, type TodayConfig } from '../config/config.service';
import { liveLine } from '../meditations/meditation.rules';

/** Matches `LiveAgg` in realtime/socket-events.ts (+ `degraded` when Redis is unreachable). */
export interface LiveSnapshot {
  total: number | null;
  countries: number | null;
  top: { c: string; n: number }[];
  quiet: boolean;
  meditatedToday: number | null;
  vibration: number;
  at: number;
  degraded?: true;
  line?: ReturnType<typeof liveLine>;
}

/** Reads the live numbers the presence engine keeps in Redis (spec §7.4). Never faked: no presence → 0. */
@Injectable()
export class LiveService {
  private readonly log = new Logger('Live');
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly config: ConfigService) {}

  async snapshot(date: string): Promise<LiveSnapshot> {
    const today = await this.config.value<TodayConfig>('today');
    try {
      const [agg, meds, vib] = await Promise.all([this.redis.hgetall(K.aggCountry), this.redis.get(K.medsToday(date)), this.redis.get(K.vibration)]);
      const entries = Object.entries(agg).map(([c, n]) => ({ c, n: Number(n) })).filter((e) => e.n > 0).sort((a, b) => b.n - a.n || a.c.localeCompare(b.c));
      const total = entries.reduce((s, e) => s + e.n, 0);
      const meditatedToday = Number(meds) || 0;
      return {
        total, countries: entries.length, top: entries.slice(0, 50), quiet: total < today.emptyRoomThreshold, meditatedToday,
        vibration: Number(vib) || 0, at: Date.now(), line: liveLine(total, meditatedToday, today.emptyRoomThreshold),
      };
    } catch (e) {
      this.log.warn(`live counts unavailable: ${(e as Error).message}`);
      return { total: null, countries: null, top: [], quiet: true, meditatedToday: null, vibration: 0, at: Date.now(), degraded: true };
    }
  }
}
