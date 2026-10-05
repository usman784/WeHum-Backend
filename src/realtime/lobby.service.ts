import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { K, REDIS } from '../infra/redis';
import { GroupService } from '../modules/today/group.service';
import { ALL_REGIONS, regionOf } from './regions';
import { HIDDEN_COUNTRY } from './presence.service';

export const LOBBY_FRESH_MS = 90_000;
const KEEP_SEC = 2 * 86_400;

export interface LobbyState { date: string; waiting: number; countries: number; regions: { r: string; n: number }[]; startsAt: string }

/** The waiting room before a group meditation (spec §7.4): `lobby:{date}` ZSET user → last seen, country in a side hash. */
@Injectable()
export class LobbyService {
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly group: GroupService) {}

  async join(date: string, userId: string, country: string | null, now = Date.now()) {
    await this.redis.multi().zadd(K.lobby(date), now, userId).hset(K.lobbyCountries(date), userId, country ?? HIDDEN_COUNTRY).expire(K.lobby(date), KEEP_SEC).expire(K.lobbyCountries(date), KEEP_SEC).exec();
  }

  async leave(date: string, userId: string) { await this.redis.multi().zrem(K.lobby(date), userId).hdel(K.lobbyCountries(date), userId).exec(); }

  /** Keeps connected lobby members "fresh" (called every 30 s by the pod that holds their sockets). */
  async touch(date: string, userIds: string[], now = Date.now()) {
    if (!userIds.length) return;
    const p = this.redis.pipeline();
    for (const u of userIds) p.zadd(K.lobby(date), 'XX', now, u);
    await p.exec();
  }

  async sweep(date: string, now = Date.now()) {
    const stale = await this.redis.zrangebyscore(K.lobby(date), '-inf', now - LOBBY_FRESH_MS);
    if (!stale.length) return 0;
    await this.redis.multi().zrem(K.lobby(date), ...stale).hdel(K.lobbyCountries(date), ...stale).exec();
    return stale.length;
  }

  /** Waiting people, how many countries and which regions (a hidden country counts as waiting, never as a country). */
  async state(date: string, now = Date.now()): Promise<LobbyState> {
    const members = await this.redis.zrangebyscore(K.lobby(date), now - LOBBY_FRESH_MS, '+inf');
    const countries = members.length ? await this.redis.hmget(K.lobbyCountries(date), ...members) : [];
    const perCountry = new Map<string, number>();
    for (const c of countries) if (c && c !== HIDDEN_COUNTRY) perCountry.set(c, (perCountry.get(c) ?? 0) + 1);
    const perRegion = new Map<string, number>();
    for (const [c, n] of perCountry) perRegion.set(regionOf(c), (perRegion.get(regionOf(c)) ?? 0) + n);
    const g = await this.group.forDate(date, now);
    return {
      date, waiting: members.length, countries: perCountry.size,
      regions: ALL_REGIONS.filter((r) => perRegion.has(r)).map((r) => ({ r, n: perRegion.get(r)! })).sort((a, b) => b.n - a.n || a.r.localeCompare(b.r)), startsAt: g.startsAt,
    };
  }
}
