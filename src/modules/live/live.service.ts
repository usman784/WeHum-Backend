import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { K, REDIS } from '../../infra/redis';
import { ConfigService, type TodayConfig } from '../config/config.service';
import { liveLine } from '../meditations/meditation.rules';
import { HIDDEN_COUNTRY } from '../../realtime/presence.service';

/** Matches `LiveAgg` in realtime/socket-events.ts (+ `degraded` when Redis is unreachable). */
export interface LiveSnapshot {
  total: number | null;
  countries: number | null;
  top: { c: string; n: number }[];
  /** Where people meditated today (country → people), for the map when nobody is live right now. */
  todayTop: { c: string; n: number }[];
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
      const [agg, meds, vib, doneByCountry] = await Promise.all([this.redis.hgetall(K.aggCountry), this.redis.get(K.medsToday(date)), this.redis.get(K.vibration), this.redis.hgetall(K.medsTodayCountry(date))]);
      const all = Object.entries(agg).map(([c, n]) => ({ c, n: Number(n) })).filter((e) => e.n > 0);
      const total = all.reduce((s, e) => s + e.n, 0); // everyone counts…
      const entries = all.filter((e) => e.c !== HIDDEN_COUNTRY).sort((a, b) => b.n - a.n || a.c.localeCompare(b.c)); // …but hidden countries are never shown
      const meditatedToday = Number(meds) || 0;
      const todayTop = Object.entries(doneByCountry).map(([c, n]) => ({ c, n: Number(n) })).filter((e) => e.n > 0 && e.c !== HIDDEN_COUNTRY).sort((a, b) => b.n - a.n || a.c.localeCompare(b.c)).slice(0, 50);
      return {
        total, countries: entries.length, top: entries.slice(0, 50), todayTop, quiet: total < today.emptyRoomThreshold, meditatedToday,
        vibration: Number(vib) || 0, at: Date.now(), line: liveLine(total, meditatedToday, today.emptyRoomThreshold),
      };
    } catch (e) {
      this.log.warn(`live counts unavailable: ${(e as Error).message}`);
      return { total: null, countries: null, top: [], todayTop: [], quiet: true, meditatedToday: null, vibration: 0, at: Date.now(), degraded: true };
    }
  }
}
