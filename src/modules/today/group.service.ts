import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { K, REDIS } from '../../infra/redis';
import { ConfigService, type GroupConfig } from '../config/config.service';
import { MotdService, addDaysIso } from '../motd/motd.service';

export type GroupState = 'scheduled' | 'lobby' | 'live' | 'ended';
const LOBBY_FRESH_MS = 90_000;

/** Group meditation timing (spec §8.1). Everything is a UTC instant; the app shows local times. */
@Injectable()
export class GroupService {
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly config: ConfigService, private readonly motd: MotdService) {}

  async forDate(date: string, now = Date.now()) {
    const cfg = await this.config.value<GroupConfig>('group');
    const day = await this.motd.forDate(date).catch(() => null);
    const startUtc = day?.group.startUtc ?? cfg.startUtc, lengthMin = day?.group.lengthMin ?? cfg.lengthMin;
    const startsAt = Date.parse(`${date}T${startUtc}:00Z`);
    const endsAt = startsAt + lengthMin * 60_000, lobbyOpensAt = startsAt - cfg.lobbyOpenMin * 60_000;
    const state: GroupState = now < lobbyOpensAt ? 'scheduled' : now < startsAt ? 'lobby' : now < endsAt ? 'live' : 'ended';
    // people who are in the lobby right now (each lobby client refreshes its score; stale entries do not count)
    const waiting = await this.redis.zcount(K.lobby(date), now - LOBBY_FRESH_MS, '+inf').catch(() => 0);
    return {
      date, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), lobbyOpensAt: new Date(lobbyOpensAt).toISOString(),
      lengthMin, reminderMin: cfg.reminderMin, state, waiting, sessionId: day?.sessionId ?? null, title: day?.title ?? null,
    };
  }

  /** Today's group while it is not over, otherwise tomorrow's. */
  async next(now = Date.now()) {
    const today = new Date(now).toISOString().slice(0, 10);
    const t = await this.forDate(today, now);
    return t.state === 'ended' ? this.forDate(addDaysIso(today, 1), now) : t;
  }
}
